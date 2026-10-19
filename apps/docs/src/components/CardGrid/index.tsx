import Link from "@docusaurus/Link";
import type { ReactNode } from "react";
import styles from "./styles.module.css";

// Outline icons on a 24-unit grid, drawn with the current text color.
const ICONS = {
  database: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
  api: (
    <>
      <path d="M8 4c-2 0-3 1-3 3v2c0 1.5-1 3-3 3 2 0 3 1.5 3 3v2c0 2 1 3 3 3" />
      <path d="M16 4c2 0 3 1 3 3v2c0 1.5 1 3 3 3-2 0-3 1.5-3 3v2c0 2-1 3-3 3" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 9-9" />
      <path d="m17 6 3 3" />
      <path d="m14 9 2 2" />
    </>
  ),
  code: (
    <>
      <path d="m8 7-5 5 5 5" />
      <path d="m16 7 5 5-5 5" />
      <path d="m14 4-4 16" />
    </>
  ),
  server: (
    <>
      <rect x="3" y="4" width="18" height="7" rx="1.5" />
      <rect x="3" y="13" width="18" height="7" rx="1.5" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </>
  ),
  rocket: (
    <>
      <path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2" />
      <path d="M9 15 6 12c1-3 4-8 12-9-1 8-6 11-9 12Z" />
      <circle cx="14" cy="10" r="1.5" />
    </>
  ),
  book: (
    <>
      <path d="M4 5c0-1 1-2 2-2h14v16H6c-1 0-2 1-2 2V5Z" />
      <path d="M4 19c0-1 1-2 2-2h14" />
    </>
  ),
};

export interface CardItem {
  title: string;
  description: ReactNode;
  icon: keyof typeof ICONS;
  /** Makes the whole card a link. */
  href?: string;
}

/** A responsive grid of cards: features, or links into the docs. */
export default function CardGrid({ items }: { items: CardItem[] }): ReactNode {
  return (
    <div className={styles.grid}>
      {items.map((item) => {
        const body = (
          <>
            <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden="true">
              {ICONS[item.icon]}
            </svg>
            <span className={styles.title}>{item.title}</span>
            <span className={styles.description}>{item.description}</span>
          </>
        );
        return item.href ? (
          <Link
            key={item.title}
            to={item.href}
            className={`${styles.card} ${styles.link}`}
          >
            {body}
          </Link>
        ) : (
          <div key={item.title} className={styles.card}>
            {body}
          </div>
        );
      })}
    </div>
  );
}
