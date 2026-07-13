function readBaseUrl() {
  const explicit = process.argv.find((arg) => arg.startsWith('--base='))
  return (explicit?.slice('--base='.length) || process.env.APP_BASE_URL || 'https://cursoreducao.slowgithub.workers.dev').replace(/\/+$/, '')
}

const baseUrl = readBaseUrl()

const checks = [
  { label: 'health', path: '/health', expectJson: true },
  { label: 'home', path: '/' },
  { label: 'login', path: '/login.html' },
  { label: 'site puppin-teste', path: '/redacao/puppin-teste' },
  { label: 'robots', path: '/robots.txt' },
  { label: 'sitemap', path: '/sitemap.xml' },
  { label: 'manifest', path: '/site.webmanifest' }
]

async function fetchCheck({ label, path, expectJson }) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { 'user-agent': 'redacao-smoke/1.0' }
  })
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`)
  if (expectJson) {
    const data = await response.json()
    if (data?.ok !== true || data?.service !== 'redacao') {
      throw new Error(`${label}: resposta JSON inesperada`)
    }
  } else {
    await response.text()
  }
  return `${label}: OK ${response.status}`
}

const results = []
for (const check of checks) {
  results.push(await fetchCheck(check))
}

console.log(`Smoke remoto em ${baseUrl}`)
for (const result of results) console.log(`- ${result}`)
