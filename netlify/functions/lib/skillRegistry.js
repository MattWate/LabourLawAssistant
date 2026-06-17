const crypto = require('crypto');

const DEFAULT_VERSION = 'v1.0';

function sha256(value = '') {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

async function loadSkillAsset(supabase, assetName, version = null) {
  const requestedVersion = version || process.env.VRS_SKILL_VERSION || null;
  let query = supabase
    .from('protected_skill_assets')
    .select('asset_name, asset_type, version, content, storage_bucket, storage_path, sha256, status, created_at, activated_at')
    .eq('asset_name', assetName)
    .eq('status', 'active')
    .limit(1);

  if (requestedVersion) {
    query = query.eq('version', requestedVersion);
  } else {
    query = query.order('activated_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false });
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`Failed to load skill asset ${assetName}: ${error.message}`);
  if (!data) throw new Error(`Skill asset not found or not active: ${assetName}${requestedVersion ? ` ${requestedVersion}` : ''}`);

  if (data.content) {
    return {
      ...data,
      content: data.content,
      resolved_hash: data.sha256 || sha256(data.content)
    };
  }

  if (data.storage_bucket && data.storage_path) {
    const { data: fileData, error: storageError } = await supabase.storage
      .from(data.storage_bucket)
      .download(data.storage_path);
    if (storageError) throw new Error(`Failed to download skill asset ${assetName}: ${storageError.message}`);
    const content = await fileData.text();
    return {
      ...data,
      content,
      resolved_hash: data.sha256 || sha256(content)
    };
  }

  throw new Error(`Skill asset ${assetName} has no content or storage location`);
}

async function loadWpSkillSet(supabase, options = {}) {
  const side = String(options.side || 'employee').toLowerCase();
  const version = options.version || process.env.VRS_SKILL_VERSION || DEFAULT_VERSION;
  const promptAsset = side === 'employer' ? 'WP_EMPLOYER_PROMPT' : 'WP_EMPLOYEE_PROMPT';
  const routingAsset = side === 'employer' ? 'SKILL_WPLETTER_EMPLOYER' : 'SKILL_WPLETTER_EMPLOYEE';

  const assets = {};
  for (const name of ['VRS_HOUSE_STYLE', 'SKILL_WORKFLOW', 'SKILL_MATTER_ASSESSMENT', routingAsset, promptAsset]) {
    assets[name] = await loadSkillAsset(supabase, name, version);
  }

  const hashes = Object.values(assets).map(asset => `${asset.asset_name}:${asset.version}:${asset.resolved_hash}`);
  const skillHash = sha256(hashes.join('|'));

  return {
    side,
    version,
    promptAsset,
    routingAsset,
    assets,
    skill_hash: skillHash,
    manifest: Object.fromEntries(Object.entries(assets).map(([name, asset]) => [name, {
      version: asset.version,
      sha256: asset.resolved_hash,
      asset_type: asset.asset_type
    }]))
  };
}

function buildProtectedPromptContext(skillSet) {
  const asset = name => skillSet.assets[name]?.content || '';
  const routing = asset(skillSet.routingAsset);
  const prompt = asset(skillSet.promptAsset);

  return [
    '=== VRS HOUSE STYLE ===',
    asset('VRS_HOUSE_STYLE'),
    '=== VRS WORKFLOW AND SUPERVISORY NOTES ===',
    asset('SKILL_WORKFLOW'),
    '=== VRS MATTER ASSESSMENT STANDARD ===',
    asset('SKILL_MATTER_ASSESSMENT'),
    '=== WP LETTER ROUTING SKILL ===',
    routing,
    '=== AUTHORITATIVE WP DRAFTING PROMPT ===',
    prompt
  ].join('\n\n');
}

module.exports = {
  loadSkillAsset,
  loadWpSkillSet,
  buildProtectedPromptContext,
  sha256
};