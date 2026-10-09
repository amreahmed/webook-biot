async function assertNoSecurityChallenge(page) {
  const title = await page.title().catch(() => "");
  if (!/just a moment|attention required/i.test(title)) return;
  const body = await page.locator("body").innerText({ timeout: 1000 }).catch(() => "");
  if (!/cloudflare|performing security verification|verify you are (?:not )?human|verifies you are not a bot/i.test(body)) return;

  const cleared = await page.waitForFunction(
    () => !/just a moment|attention required/i.test(document.title),
    null,
    { timeout: 5000 },
  ).then(() => true, () => false);
  if (cleared) return;
  const error = new Error("Webook requires security verification in the browser. Complete verification before re-linking accounts.");
  error.loginFailureCode = "verification-required";
  throw error;
}

module.exports = { assertNoSecurityChallenge };
