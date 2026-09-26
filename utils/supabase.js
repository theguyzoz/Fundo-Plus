export {
  syncFromSupabase,
  syncToSupabase,
  uploadDataFile   as uploadFile,
  downloadDataFile as downloadFile,
  MANAGED_FILES,
  getDataStats,
  checkDataCapacity,
} from './supabase-data.js';

export {
  uploadResource       as uploadPaper,
  backfillResource     as backfillPaper,
  deleteResource       as deletePaper,
  listResources        as listPapers,
  getResourceUrl,
  getResourcesStats,
  getResourcesConfig,
  checkResourcesCapacity,
} from './supabase-resources.js';

export async function syncAuthToSupabase()   {}
export async function syncAuthFromSupabase() {}
export function getSupabase() { return null; }
