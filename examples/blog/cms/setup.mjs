const url = process.argv[2] ?? "http://127.0.0.1:8787";
const token = process.env.CMS_WRITE_KEY;

const headers = { "Content-Type": "application/json" };
if (token) headers.Authorization = `Bearer ${token}`;

const response = await fetch(new URL("/api/setup", url), {
  method: "POST",
  headers,
});

if (!response.ok) {
  console.error(await response.text());
  process.exit(1);
}

console.log(JSON.stringify(await response.json(), null, 2));
