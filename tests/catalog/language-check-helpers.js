import { languageCheckDigestForArtifact } from '../../scripts/catalog/language-check.js';

const ENGLISH_LANGUAGE = '/languages/eng';

export function sealLanguageCheckedArtifact(artifact, {
  editionsBasename = 'ol_dump_editions_fixture.txt.gz',
  editionsBytes = 1,
  enrichedInputSha256 = '0'.repeat(64),
  keepUnknownLanguage = false,
} = {}) {
  const candidates = artifact.candidates.map(candidate => ({
    ...candidate,
    languages: Array.isArray(candidate.languages) ? [...candidate.languages].sort() : [ENGLISH_LANGUAGE],
  }));
  const sealed = {
    ...artifact,
    languageCheck: 'passed',
    languageCheckEditions: { basename: editionsBasename, bytes: editionsBytes },
    languageCheckEnrichedInputSha256: enrichedInputSha256,
    languageCheckKeepUnknownLanguage: keepUnknownLanguage,
    counts: { ...artifact.counts, selected: candidates.length },
    candidates,
  };
  return { ...sealed, languageCheckDigest: languageCheckDigestForArtifact(sealed) };
}
