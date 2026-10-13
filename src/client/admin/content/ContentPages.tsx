import { useEffect, useRef, useState } from "react";
import type { CmsRecord } from "../../../shared/cms-schema.ts";
import { apiRequest } from "../../api/client.ts";
import { uploadImage } from "../../media/prepareImage.ts";
import { useAdmin } from "../AdminContext.tsx";
import { CmsManager, enumLabel, PageTabs, recordTitle, useCmsList } from "../cms/CmsKit.tsx";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { Alert, Button, detailMessage } from "../ui.tsx";

function useDateTime() {
  const { locale } = useAdmin();
  const fmt = new Intl.DateTimeFormat(locale.code, { dateStyle: "medium", timeStyle: "short" });
  return (iso: unknown) => (typeof iso === "string" && iso ? fmt.format(new Date(iso)) : "");
}

/** Home page: hero slideshow (spec §9) and page sections (spec §8). */
export function HomeContentPage() {
  const { c } = useAdmin();
  const [tab, setTab] = useState<"slides" | "sections">("slides");
  const when = useDateTime();
  return (
    <section>
      <h1 className="adm-h1">{c.content.home}</h1>
      <p className="adm-muted">{c.content.publicNote}</p>
      <PageTabs label={c.content.home} value={tab} onChange={setTab}
        tabs={[{ value: "slides", label: c.content.slides }, { value: "sections", label: c.content.sections }]} />
      {tab === "slides" ? (
        <CmsManager key="slides" entity="homeSlide" newLabel={c.content.newSlide}
          summary={(r) => [r.startAt ? `${c.fields.startAt}: ${when(r.startAt)}` : "", r.endAt ? `${c.fields.endAt}: ${when(r.endAt)}` : ""].filter(Boolean).join(" · ")} />
      ) : (
        <CmsManager key="sections" entity="homeSection" newLabel={c.content.newSection}
          summary={(r) => enumLabel(c, "sectionType", r.sectionType as string)} />
      )}
    </section>
  );
}

/** Gallery CMS (spec §10): categories, images with multi-upload, publish. */
export function GalleryPage() {
  const { c, t, can, locale } = useAdmin();
  const [tab, setTab] = useState<"images" | "categories">("images");
  const [category, setCategory] = useState("");
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [publishing, setPublishing] = useState<string | null>(null);
  const categories = useCmsList("galleryCategory");
  const refOptions = {
    categoryId: (categories.items ?? []).map((cat) => ({ value: cat.id, label: recordTitle(cat, locale.code, cat.slug as string) })),
  };
  const catName = (id: unknown) => refOptions.categoryId.find((o) => o.value === id)?.label ?? c.content.uncategorized;
  /** The public Gallery shows an image only when its category is published too (public-content.service). */
  const draft = (categories.items ?? []).filter((cat) => cat.status !== "PUBLISHED");
  const isDraft = (id: unknown) => draft.some((cat) => cat.id === id);
  const warnFor = category === "" ? draft : draft.filter((cat) => cat.id === category);

  async function publishCategory(id: string, name: string) {
    setPublishing(id);
    setNotice(null);
    try {
      await apiRequest("POST", `/api/admin/cms/galleryCategory/${encodeURIComponent(id)}/publish`);
      setNotice({ kind: "success", text: format(c.content.categoryPublished, { name }) });
      await categories.reload();
    } catch (err) {
      setNotice({ kind: "error", text: detailMessage(t, err) });
    } finally {
      setPublishing(null);
    }
  }

  return (
    <section>
      <h1 className="adm-h1">{c.content.gallery}</h1>
      <p className="adm-muted">{c.content.publicNote} {c.content.galleryRule}</p>
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      {tab === "images" && warnFor.map((cat) => {
        const name = catName(cat.id);
        return (
          <div key={cat.id} className="adm-alert adm-alert--info adm-gallery-draft" role="status">
            <p>{format(c.content.categoryDraft, { name })}</p>
            {can("content.publish")
              ? <Button busy={publishing === cat.id} onClick={() => void publishCategory(cat.id, name)}>{format(c.content.publishCategory, { name })}</Button>
              : <p className="adm-small">{c.content.askPublisher}</p>}
          </div>
        );
      })}
      <PageTabs label={c.content.gallery} value={tab} onChange={(v) => { setTab(v); void categories.reload(); }}
        tabs={[{ value: "images", label: c.content.images }, { value: "categories", label: c.content.categories }]} />
      {tab === "images" ? (
        <CmsManager key={`images-${category}`} entity="galleryImage" newLabel={c.ui.add} refOptions={refOptions}
          query={category ? `categoryId=${encodeURIComponent(category)}` : ""}
          presets={category && category !== "none" ? { categoryId: category } : {}}
          summary={(r) => [catName(r.categoryId), enumLabel(c, "layoutSpan", r.layoutSpan as string), isDraft(r.categoryId) ? c.content.categoryDraftTag : null]
            .filter(Boolean).join(" · ")}
          toolbar={(reload) => (
            <>
              <label className="adm-field adm-field--inline">
                <span>{c.fields.categoryId}</span>
                <select value={category} onChange={(e) => setCategory(e.currentTarget.value)}>
                  <option value="">{c.ui.all}</option>
                  <option value="none">{c.content.uncategorized}</option>
                  {refOptions.categoryId.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
              {can("content.gallery") && <MultiUpload categoryId={category && category !== "none" ? category : null} onDone={reload} />}
            </>
          )} />
      ) : (
        <CmsManager key="categories" entity="galleryCategory" newLabel={c.content.newCategory}
          summary={(r) => `/${r.slug as string}`} />
      )}
      {categories.error && <Alert kind="error">{categories.error}</Alert>}
    </section>
  );
}

/** Uploads several images; each becomes a DRAFT gallery image. */
function MultiUpload({ categoryId, onDone }: { categoryId: string | null; onDone: () => Promise<void> }) {
  const { c, t } = useAdmin();
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function upload(files: FileList) {
    setError(null);
    let done = 0;
    for (const file of [...files]) {
      setProgress(`${c.ui.uploading} ${done + 1}/${files.length}`);
      try {
        const asset = await uploadImage(file, "GALLERY");
        await apiRequest<CmsRecord>("POST", "/api/admin/cms/galleryImage", { mediaAssetId: asset.id, categoryId });
        done++;
      } catch (err) {
        setError(`${file.name}: ${detailMessage(t, err)}`);
      }
    }
    setProgress(null);
    if (input.current) input.current.value = "";
    await onDone();
  }

  return (
    <div>
      <input ref={input} type="file" multiple hidden accept="image/jpeg,image/png,image/webp,image/avif" aria-label={c.ui.uploadMany}
        onChange={(e) => { const f = e.currentTarget.files; if (f?.length) void upload(f); }} />
      <Button variant="secondary" busy={!!progress} onClick={() => input.current?.click()}>{progress ?? c.ui.uploadMany}</Button>
      <p className="adm-field__hint">{c.content.uploadHint}</p>
      {error && <p className="adm-field__error" role="alert">{error}</p>}
    </div>
  );
}

/** History page (spec §11): sections and timeline. */
export function HistoryPage() {
  const { c } = useAdmin();
  const [tab, setTab] = useState<"sections" | "timeline">("sections");
  return (
    <section>
      <h1 className="adm-h1">{c.content.history}</h1>
      <p className="adm-muted">{c.content.publicNote}</p>
      <PageTabs label={c.content.history} value={tab} onChange={setTab}
        tabs={[{ value: "sections", label: c.content.sections }, { value: "timeline", label: c.content.timeline }]} />
      {tab === "sections" ? (
        <CmsManager key="sections" entity="historySection" newLabel={c.content.newSection}
          summary={(r) => `${enumLabel(c, "sectionType", r.sectionType as string)} · ${enumLabel(c, "layout", r.layout as string)}`} />
      ) : (
        <CmsManager key="timeline" entity="historyTimeline" newLabel={c.content.newTimeline} summary={(r) => String(r.year)} />
      )}
    </section>
  );
}

/** Keeps a list of options (id → label) for selects. */
export function useOptions(entity: "foodCategory" | "foodOption" | "galleryCategory") {
  const { locale, c } = useAdmin();
  const list = useCmsList(entity);
  const [options, setOptions] = useState<{ value: string; label: string; record: CmsRecord }[]>([]);
  useEffect(() => {
    setOptions((list.items ?? []).map((r) => ({ value: r.id, label: recordTitle(r, locale.code, (r.code as string) ?? c.ui.untitled), record: r })));
  }, [list.items, locale.code, c.ui.untitled]);
  return { options, reload: list.reload };
}
