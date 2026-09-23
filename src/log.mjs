export function log(event, fields = {}) {
  console.info(JSON.stringify({ event, ...fields }));
}

export function logFailure(event, error, fields = {}) {
  // Only messages authored by this service are safe to print. In particular,
  // fetch/JSON parser errors may contain upstream content or routing details.
  const safe = ['invalid_config', 'invalid_snapshot', 'public_data_error'].includes(error?.code);
  console.error(JSON.stringify({
    event, ...fields, error: error?.name, code: error?.code,
    message: safe ? error.message : undefined,
    stack: error?.stack?.split('\n').filter(line => /^\s+at /.test(line)).join('\n'),
  }));
}
