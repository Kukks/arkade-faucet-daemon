export async function requestOnchain({ faucetApi, token, sats, address }, fetchFn = fetch) {
  const res = await fetchFn(`${faucetApi}/api/onchain`, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({ sats, address }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`onchain replenish failed (${res.status}): ${text}`);
  }
}
