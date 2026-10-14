import { useEffect, useState } from "react";
import type { PublicCampingDto, PublicUnitDto } from "../../shared/accommodation-types.ts";
import { fill } from "../accommodation/UnitCard.tsx";
import { Stepper } from "./FoodStep.tsx";
import { useBookingT } from "./useBookingT.ts";

/** One stay the guest picked, with its own guests (several stays share the booking's dates). */
export type Pick =
  | { kind: "UNIT"; unit: PublicUnitDto; adults: number; children: number }
  | { kind: "CAMPING"; tents: number; tarp: boolean; adults: number; children: number };

export const pickKey = (p: Pick) => (p.kind === "UNIT" ? p.unit.id : "camping");

/** What is wrong with a pick (null = fine): no guests, over the unit's capacity, camping without an adult. */
export function pickProblem(p: Pick, bt: ReturnType<typeof useBookingT>): string | null {
  const guests = p.adults + p.children;
  if (guests < 1) return bt.pickNoGuests;
  if (p.kind === "UNIT") {
    if (guests > p.unit.maxGuests || (p.unit.maxAdults !== null && p.adults > p.unit.maxAdults)) return fill(bt.pickTooMany, { n: p.unit.maxGuests });
    return null;
  }
  return p.adults < 1 ? bt.pickNeedAdult : null;
}

/**
 * Guests for a house / VIP tent the guest just added: whoever the search asked for and no other stay holds yet,
 * up to what the unit takes — adults first. Nobody left: one adult (the total grows; every number can be changed).
 */
export function guestsForNewUnit(unit: PublicUnitDto, wanted: { adults: number; children: number }, picks: Pick[]): { adults: number; children: number } {
  const taken = picks.reduce((acc, p) => ({ adults: acc.adults + p.adults, children: acc.children + p.children }), { adults: 0, children: 0 });
  const freeAdults = Math.max(0, wanted.adults - taken.adults);
  const freeChildren = Math.max(0, wanted.children - taken.children);
  const adults = Math.min(freeAdults, unit.maxAdults ?? unit.maxGuests, unit.maxGuests);
  const children = Math.min(freeChildren, unit.maxGuests - adults);
  return adults + children > 0 ? { adults, children } : { adults: 1, children: 0 };
}

/**
 * The stays picked so far, before the booking steps: each house / VIP tent with steppers for its guests (within what
 * it takes), the camping pitch with its tents (changed in the camping form), and the way on.
 */
export function StayPicks({ picks, camping, campingName, onChange, onEditCamping, onNext }: {
  picks: Pick[];
  camping: PublicCampingDto | null;
  campingName: string;
  onChange: (picks: Pick[]) => void;
  onEditCamping: () => void;
  onNext: () => void;
}) {
  const bt = useBookingT();
  const totals = picks.reduce((acc, p) => ({ adults: acc.adults + p.adults, children: acc.children + p.children }), { adults: 0, children: 0 });
  const problems = picks.map((p) => pickProblem(p, bt));
  const ready = picks.length > 0 && totals.adults >= 1 && problems.every((x) => x === null);
  const update = (key: string, patch: Partial<{ adults: number; children: number }>) =>
    onChange(picks.map((p) => (pickKey(p) === key ? ({ ...p, ...patch } as Pick) : p)));

  return (
    <section className="picks" id="picks" aria-labelledby="picks-h">
      <h2 id="picks-h" className="picks__title">{bt.picksTitle}</h2>
      <p className="picks__hint">{bt.picksHint}</p>
      <ul className="picks__list">
        {picks.map((p, i) => {
          const key = pickKey(p);
          const name = p.kind === "UNIT" ? p.unit.name : campingName;
          const problem = problems[i];
          return (
            <li key={key} className={`pick${problem ? " is-invalid" : ""}`} aria-label={name}>
              <div className="pick__head">
                <strong className="pick__name">{name}</strong>
                <span className="pick__meta">
                  {p.kind === "UNIT" ? fill(bt.pickCapacity, { n: p.unit.maxGuests })
                    : `${fill(bt.tentsLine, { n: p.tents })}${p.tarp ? ` + ${bt.tarpLine}` : ""}`}
                </span>
                <span className="pick__actions">
                  {p.kind === "CAMPING" && (
                    <button type="button" className="button button--ghost" aria-label={`${bt.pickEdit}: ${name}`} onClick={onEditCamping}>{bt.pickEdit}</button>
                  )}
                  <button type="button" className="button button--ghost" aria-label={`${bt.pickRemove}: ${name}`}
                    onClick={() => onChange(picks.filter((x) => pickKey(x) !== key))}>{bt.pickRemove}</button>
                </span>
              </div>
              {p.kind === "UNIT" ? (
                <div className="pick__counts">
                  <div className="pick__count">
                    <span className="pick__label">{bt.adults}</span>
                    <Stepper label={`${name} · ${bt.adults}`} value={p.adults} min={0}
                      max={Math.max(p.adults, Math.min(p.unit.maxAdults ?? p.unit.maxGuests, p.unit.maxGuests - p.children))}
                      onChange={(n) => update(key, { adults: n })} />
                  </div>
                  <div className="pick__count">
                    <span className="pick__label">{camping ? fill(bt.children, { age: camping.childFreeUnderAge }) : bt.childrenShort}</span>
                    <Stepper label={`${name} · ${bt.childrenShort}`} value={p.children} min={0}
                      max={Math.max(p.children, p.unit.maxGuests - p.adults)} onChange={(n) => update(key, { children: n })} />
                  </div>
                </div>
              ) : (
                <p className="pick__guests">{fill(bt.guestsLine, { adults: p.adults, children: p.children })}</p>
              )}
              {problem && <p className="field-error" role="alert">{problem}</p>}
            </li>
          );
        })}
      </ul>
      <div className="picks__foot">
        <p className="picks__total" aria-live="polite">{fill(bt.pickTotal, { n: picks.length, adults: totals.adults, children: totals.children })}</p>
        <button type="button" className="button button--primary" disabled={!ready} onClick={onNext}>{bt.next} →</button>
      </div>
    </section>
  );
}

/**
 * Fixed bar while the guest scrolls through the stays: how many are picked, a way back to them, and on.
 * It steps aside while the panel's own total and "next" are on screen, so it never covers them.
 */
export function PicksBar({ picks, onNext, ready }: { picks: Pick[]; ready: boolean; onNext: () => void }) {
  const bt = useBookingT();
  const [footInView, setFootInView] = useState(false);
  const hasPicks = picks.length > 0;
  useEffect(() => {
    const foot = document.querySelector("#picks .picks__foot");
    if (!hasPicks || !foot || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setFootInView(!!e?.isIntersecting));
    io.observe(foot);
    return () => io.disconnect();
  }, [hasPicks]);
  const totals = picks.reduce((acc, p) => ({ adults: acc.adults + p.adults, children: acc.children + p.children }), { adults: 0, children: 0 });
  if (footInView) return null;
  return (
    <div className="picks-bar" role="region" aria-label={bt.picksTitle}>
      <a href="#picks" className="picks-bar__summary">
        <strong>{fill(bt.staysCount, { n: picks.length })}</strong>
        <span>{fill(bt.guestsLine, totals)}</span>
      </a>
      <button type="button" className="button button--primary" disabled={!ready} onClick={onNext}>{bt.next} →</button>
    </div>
  );
}
