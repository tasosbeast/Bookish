import {
  buildOpenLibraryWorkIndexCore,
  REFERENCE_WORK_INDEX_LOADERS,
} from '../../scripts/catalog/open-library-works.js';

export function buildLegacyWorkIndex(options) {
  return buildOpenLibraryWorkIndexCore(options, REFERENCE_WORK_INDEX_LOADERS);
}
