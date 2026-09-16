import { getCatalogEntry, validateCatalogEntry, validateDocsUrl } from './catalog.js';

// Revalidate catalog data at the response boundary so malformed metadata never becomes a usage field.
export function catalogMetadata(providerId) {
  const entry = getCatalogEntry(providerId);
  if (!entry || typeof entry !== 'object') return {};
  try {
    validateCatalogEntry(entry);
  } catch {
    return {};
  }
  const metadata = {
    access: entry.access,
    credentialType: entry.credentialType,
  };
  if (validateDocsUrl(entry.docsUrl)) metadata.docsUrl = entry.docsUrl;
  if (entry.setupCommand !== undefined) metadata.setupCommand = entry.setupCommand;
  return metadata;
}
