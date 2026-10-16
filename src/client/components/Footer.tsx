import { Fragment } from "react";
import { splitPhones, telHref } from "../../shared/phones.ts";
import { pagePath, type PublicPage } from "../../shared/routes.ts";
import { useConsent } from "../consent/ConsentProvider.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { Link } from "../router/Router.tsx";
import { useSite } from "../site/SiteProvider.tsx";
import { FooterMap } from "./FooterMap.tsx";
import { LanguageSwitcher } from "./LanguageSwitcher.tsx";
import { MAIN_MENU } from "./navigation.ts";

/**
 * Footer. Name, tagline, contact details and footer text come from D1 (Settings → Website).
 */
export function Footer({ currentPage }: { currentPage: PublicPage | null }) {
  const { locale, t } = useI18n();
  const { site } = useSite();
  const { manageable, openSettings } = useConsent();
  const policyPath = site?.consent?.policyPath ?? null;
  const year = new Date().getFullYear();

  return (
    <footer className="site-footer">
      <div className="container site-footer__inner">
        <div className="site-footer__brand">
          {site?.siteName && <p className="site-footer__name">{site.siteName}</p>}
          {site?.tagline && <p className="site-footer__tagline">{site.tagline}</p>}
          {site?.footerText && <p className="site-footer__text">{site.footerText}</p>}
        </div>

        {site && (site.contact.phone || site.contact.email || site.contact.lineOaUrl || site.contact.address || site.contact.mapUrl || site.contact.coordinates) && (
          <address className="site-footer__contact" aria-label={t.footer.contact}>
            <p className="site-footer__heading">{t.footer.contact}</p>
            {site.contact.address && <p>{site.contact.address}</p>}
            {(site.contact.phone || site.contact.email) && (
              <p className="site-footer__reach">
                {site.contact.phone && (
                  <span>
                    {t.footer.phone}:{" "}
                    {splitPhones(site.contact.phone).map((p, i) => (
                      <Fragment key={p}>{i > 0 && ", "}<a href={telHref(p)}>{p}</a></Fragment>
                    ))}
                  </span>
                )}
                {site.contact.email && <span>{t.footer.email}: <a href={`mailto:${site.contact.email}`}>{site.contact.email}</a></span>}
              </p>
            )}
            {site.contact.lineOaUrl && <p><a href={site.contact.lineOaUrl} rel="noopener noreferrer" target="_blank">{t.footer.line}</a></p>}
            <FooterMap label={t.footer.map} mapUrl={site.contact.mapUrl} coordinates={site.contact.coordinates} />
          </address>
        )}

        <nav className="site-footer__nav" aria-label={t.footer.navigation}>
          <ul>
            {MAIN_MENU.map(({ page, label }) => (
              <li key={page}>
                <Link to={pagePath(locale, page)} aria-current={currentPage === page ? "page" : undefined}>
                  {label(t)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <LanguageSwitcher className="lang-switcher--footer" />
      </div>

      <div className="container site-footer__legal">
        <small>
          © {year}
          {site?.siteName ? ` ${site.siteName}` : ""} · {t.footer.rights}
        </small>
        {(policyPath || manageable) && (
          <ul className="site-footer__legal-links">
            {policyPath && <li><Link to={policyPath}>{t.footer.privacy}</Link></li>}
            {manageable && <li><button type="button" className="link-button" onClick={openSettings} aria-haspopup="dialog">{t.footer.cookieSettings}</button></li>}
          </ul>
        )}
      </div>
    </footer>
  );
}
