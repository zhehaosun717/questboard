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
      {/* Guild section rule: the English category rides above as a letterspaced brass label, the Chinese
          heading carries the meaning, and a hairline steel rule closes the line. */}
      <h3 className="mb-2 flex items-baseline gap-2.5 border-b border-steel pb-1.5 font-han text-[18px] font-normal leading-none text-tag">
        <span className="font-display text-[11px] tracking-[.3em] text-rust">{en}</span>
        {zh}
      </h3>
      {children}
    </section>
  );
}
