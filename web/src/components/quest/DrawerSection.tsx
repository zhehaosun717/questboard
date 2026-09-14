import type { ReactNode } from 'react';

export function DrawerSection({
  en,
  zh,
  children,
}: {
  en: string;
  zh: string;
  children: ReactNode;
}) {
  return (
    <section className="d-sec">
      <h3>
        <span>{en}</span>
        {zh}
      </h3>
      {children}
    </section>
  );
}
