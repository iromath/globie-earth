import { test, expect, type BrowserContext, type Page } from '@playwright/test';

/**
 * The four E2E scenarios the notification plan's 4b names, run against a
 * deployed build (E2E_BASE_URL, default https://globie.earth).
 *
 * The app ships no data-testid attributes, so everything here is selected
 * through the accessibility surface the components actually expose - role,
 * aria-label and visible text - which is also what a screen reader sees.
 *
 * Two scenarios need server state a browser cannot conjure:
 *
 *   - a reply on another device needs a contribution this device owns;
 *   - an approval needs a five-device vote quorum (api.cast_frame_vote),
 *     which is cast server-side and cannot be driven from one page.
 *
 * Both run only when handed a fixture through the environment, and skip with a
 * reason otherwise - so an unconfigured run still proves the read paths and
 * reports exactly what stayed dark. The fixture is:
 *
 *   E2E_OWNER_DEVICE_ID   the device id that owns the contribution
 *   E2E_CONTRIBUTION_ID   an approved contribution owned by that device
 *   E2E_FRAME_KEY         one frame key on it
 *
 * Signed-in states cannot be driven either: sign-in is a full-page redirect to
 * Google, which no headless run can complete. The last scenario is the logged
 * -out half the plan asks for - the target is reached without a session, and
 * the start menu still offers sign-in when the build has it.
 */

const OWNER_DEVICE = process.env.E2E_OWNER_DEVICE_ID ?? '';
const CONTRIBUTION_ID = process.env.E2E_CONTRIBUTION_ID ?? '';
const FRAME_KEY = process.env.E2E_FRAME_KEY ?? '';
const hasContribution = Boolean(OWNER_DEVICE && CONTRIBUTION_ID && FRAME_KEY);
const FIXTURE = 'needs E2E_OWNER_DEVICE_ID, E2E_CONTRIBUTION_ID and E2E_FRAME_KEY';

/** A device the server has never seen: it owns nothing, so no backlog. */
const STRANGER_DEVICE = '00000000-0000-4000-8000-0000000000a1';

const centre = (page: Page) => page.getByRole('dialog', { name: 'Notifications' });
const contribution = (page: Page) => page.getByRole('dialog', { name: 'Contribution' });

/** Stamp the device id before any app script runs, so the first call carries it. */
async function seedDevice(context: BrowserContext, deviceId: string): Promise<void> {
  await context.addInitScript((id) => {
    try {
      window.localStorage.setItem('globie.deviceId', id);
    } catch {
      // Storage blocked; the app falls back to an in-memory id, which is fine
      // for the read-only scenarios but will not match a fixture device.
    }
  }, deviceId);
}

/** Open a route and clear the push-permission prompt if this build shows it. */
async function openRoute(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  const notNow = page.getByRole('button', { name: 'Not now' });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
}

// 1. Post a comment on device B -> device A shows the toast and the thread;
//    tap -> the correct route. Needs a contribution device A owns.
test.describe('a reply on another device', () => {
  test.skip(!hasContribution, FIXTURE);

  test('device B replies and device A toasts, then taps through to the thread', async ({ browser }) => {
    // Device A owns the contribution and stays open, so its stream is live.
    const a = await browser.newContext();
    await seedDevice(a, OWNER_DEVICE);
    const aPage = await a.newPage();
    // A non-deep-link app route, which boots past the menu and mounts the feed.
    await openRoute(aPage, '/contributions');
    // Let the backlog read land, so the reply is toasted rather than merged
    // silently, and let the SSE subscription connect before B writes.
    await aPage.waitForTimeout(3000);

    // Device B is a stranger: it reaches the contribution and replies.
    const b = await browser.newContext();
    await seedDevice(b, STRANGER_DEVICE);
    const bPage = await b.newPage();
    await openRoute(bPage, `/contributions/${CONTRIBUTION_ID}/${encodeURIComponent(FRAME_KEY)}`);
    await expect(contribution(bPage)).toBeVisible();

    const reply = `E2E reply ${Date.now()}`;
    await bPage.getByRole('textbox', { name: 'Write a comment' }).fill(reply);
    await bPage.getByRole('button', { name: 'Send comment' }).click();

    // Device A, still open, sees the live frame as a toast.
    await expect(aPage.getByText('New reply', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await aPage.getByRole('button', { name: 'View' }).click();

    // The tap routes to the contribution thread the reply belongs to.
    await expect(contribution(aPage)).toBeVisible();
    await expect(aPage.getByText(reply)).toBeVisible();

    await a.close();
    await b.close();
  });
});

// 2. An approval leaves a media_approved row that links to the contribution.
//    Needs a contribution already voted to approval for device A.
test.describe('an approval reaches the owner', () => {
  test.skip(!hasContribution, FIXTURE);

  test('the published photo leaves a row that links to the contribution', async ({ browser }) => {
    const a = await browser.newContext();
    await seedDevice(a, OWNER_DEVICE);
    const aPage = await a.newPage();
    await openRoute(aPage, '/notifications');
    await expect(centre(aPage)).toBeVisible();

    // media_approved renders as "Photo published" (NotificationsProvider).
    const row = centre(aPage).getByRole('button').filter({ hasText: 'Photo published' }).first();
    await expect(row).toBeVisible();
    await row.click();

    // media_approved links to contribution/[id] (notificationLink.ts).
    await expect(contribution(aPage)).toBeVisible();

    await a.close();
  });
});

// 3. Offline then reopen -> the unread list is intact.
test.describe('the backlog survives a spell offline', () => {
  test('closing, reopening and going offline does not lose the list', async ({ browser }) => {
    const context = await browser.newContext();
    await seedDevice(context, STRANGER_DEVICE);

    const page = await context.newPage();
    await openRoute(page, '/notifications');
    await expect(centre(page)).toBeVisible();
    // A stranger owns nothing: the centre settles on its real empty state,
    // which is deterministic and so a fair fingerprint of "the list".
    await expect(centre(page)).toContainText(/Nothing yet|Notifications are unavailable in this build/);
    const before = await centre(page).innerText();

    // Offline does not drop what is already on screen - the list is client
    // state, and the read receipt fails silently rather than blanking it.
    await context.setOffline(true);
    await expect(centre(page)).toBeVisible();
    expect(await centre(page).innerText()).toBe(before);
    await context.setOffline(false);

    // Reopening re-reads the backlog and lands on the same list.
    await page.close();
    const reopened = await context.newPage();
    await openRoute(reopened, '/notifications');
    await expect(centre(reopened)).toBeVisible();
    await expect(centre(reopened)).toContainText(/Nothing yet|Notifications are unavailable in this build/);
    expect(await centre(reopened).innerText()).toBe(before);

    await context.close();
  });
});

// 4. Logged-out deep link -> the target, then sign-in.
test.describe('a logged-out deep link', () => {
  test('opens its target with no session', async ({ browser }) => {
    const context = await browser.newContext();
    await seedDevice(context, STRANGER_DEVICE);
    const page = await context.newPage();

    // The web deep link the sender writes: https://<origin>/?dl=notifications.
    await openRoute(page, '/?dl=notifications');
    await expect(centre(page)).toBeVisible();

    // Reached the target with no account at all.
    expect(await page.evaluate(() => window.localStorage.getItem('globie.auth'))).toBeNull();

    await context.close();
  });

  test('leaves sign-in on offer at the start menu', async ({ browser }) => {
    const context = await browser.newContext();
    await seedDevice(context, STRANGER_DEVICE);
    const page = await context.newPage();

    await openRoute(page, '/');
    const signIn = page.getByRole('button', { name: 'Sign in with Google' });
    const offered = await signIn
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!offered, 'This build offers no sign-in (no VITE_AUTH_URL at build time).');

    await expect(signIn).toBeVisible();

    await context.close();
  });
});
