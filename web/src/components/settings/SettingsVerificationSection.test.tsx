import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { VerificationDraft } from '../../lib/settingsForm';
import { SettingsVerificationSection } from './SettingsVerificationSection';

const draft: VerificationDraft = {
  hooks: [{
    id: 'smoke', command: ['node', '-e', 'process.stdout.write("ok")'], timeoutSeconds: '20', cwd: '.',
    envKeys: ['CI', 'BUILD_ID'], kinds: ['code', 'review'], trigger: 'delivered', enabled: false, unknownFields: {},
  }],
};

describe('SettingsVerificationSection', () => {
  it('shows the exact argv and an opt-in toggle without implying status control', () => {
    const html = renderToStaticMarkup(<SettingsVerificationSection draft={draft} onChange={() => {}} />);
    expect(html).toContain('verification-settings');
    expect(html).toContain('[&quot;node&quot;,&quot;-e&quot;,&quot;process.stdout.write(\\&quot;ok\\&quot;)&quot;]');
    expect(html).toContain('smoke');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('config-policy-footnote');
  });

  it('renders no configured hook as a safe disabled state', () => {
    const html = renderToStaticMarkup(<SettingsVerificationSection draft={{ hooks: [] }} onChange={() => {}} />);
    expect(html).toContain('verification-empty');
    expect(html).not.toContain('type="checkbox"');
  });
});
