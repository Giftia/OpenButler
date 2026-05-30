const baseUrl = (process.env.OPENBUTLER_WEB_BASE_URL || "http://127.0.0.1:5175").replace(/\/$/, "");

const routes = [
  "/butler",
  "/butler/inbox",
  "/metrics",
  "/timeline",
  "/goals",
];

async function checkRoute(route) {
  const url = `${baseUrl}${route}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${route} returned ${response.status}`);
  }
  const body = await response.text();
  if (!body.includes('<div id="root"></div>')) {
    throw new Error(`${route} did not return the React root`);
  }
  if (!body.includes('/src/main.tsx') && !body.includes('/assets/')) {
    throw new Error(`${route} did not include an app bundle reference`);
  }
  return {route, status: response.status};
}

const results = [];
for (const route of routes) {
  results.push(await checkRoute(route));
}

console.log(JSON.stringify({baseUrl, checked: results}, null, 2));
