const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

// =========================================================
// DIAGNOSTIC RUNNER — test ONE url, log everything
// Usage: node zillow_diagnostic.js "https://www.zillow.com/..."
// =========================================================
async function diagnose() {
    const testUrl = process.argv[2];
    if (!testUrl) {
        console.error("Usage: node zillow_diagnostic.js \"<zillow-url>\"");
        process.exit(1);
    }

    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();

    await page.setRequestInterception(true);
    let blockedRequests = [];
    let allowedXHR = [];
    page.on('request', (req) => {
        if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
            blockedRequests.push(req.url());
            req.abort();
        } else {
            if (req.resourceType() === 'xhr' || req.resourceType() === 'fetch') {
                allowedXHR.push(req.url());
            }
            req.continue();
        }
    });

    console.log(`\n=== STEP 1: Navigating to ${testUrl} ===`);
    await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const pageTitle = await page.title();
    console.log(`Page title: "${pageTitle}"`);
    if (pageTitle.includes("Pardon Our Interruption") || pageTitle.includes("Robot Check")) {
        console.log("❌ BLOCKED — bot-detection challenge page served. Nothing else will work until this is bypassed.");
        await browser.close();
        return;
    }

    console.log(`\n=== STEP 2: Checking for __NEXT_DATA__ immediately after domcontentloaded ===`);
    const hasNextDataEarly = await page.evaluate(() => !!document.querySelector('script#__NEXT_DATA__'));
    console.log(`__NEXT_DATA__ present immediately: ${hasNextDataEarly}`);

    console.log(`\n=== STEP 3: Waiting for agent card selector (8s timeout) ===`);
    let agentSelectorFound = false;
    try {
        await page.waitForSelector(
            '[data-testid="listing-agent-container"], .ds-listing-agent-display-name, .ds-listing-agent-business-name',
            { timeout: 8000 }
        );
        agentSelectorFound = true;
        console.log("✅ Agent selector appeared.");
    } catch (e) {
        console.log("⏳ Agent selector did NOT appear within 8s.");
    }

    await new Promise(r => setTimeout(r, 500));

    console.log(`\n=== STEP 4: Dumping actual DOM state for agent-related selectors ===`);
    const domSnapshot = await page.evaluate(() => {
        const grab = (sel) => {
            const el = document.querySelector(sel);
            return el ? { found: true, text: el.innerText, outerHTML: el.outerHTML.slice(0, 500) } : { found: false };
        };
        return {
            header: grab('[data-testid="listing-agent-header"]'),
            container: grab('[data-testid="listing-agent-container"]'),
            name: grab('.ds-listing-agent-display-name'),
            broker: grab('.ds-listing-agent-business-name'),
            bodyLength: document.body.innerHTML.length,
            hasNextDataNow: !!document.querySelector('script#__NEXT_DATA__')
        };
    });
    console.log(JSON.stringify(domSnapshot, null, 2));

    console.log(`\n=== STEP 5: Checking __NEXT_DATA__ contents for price/agent paths ===`);
    const jsonProbe = await page.evaluate(() => {
        const script = document.querySelector('script#__NEXT_DATA__');
        if (!script) return { error: "no __NEXT_DATA__ script tag" };
        try {
            const json = JSON.parse(script.innerText);
            const componentProps = json?.props?.pageProps?.componentProps;
            const initialReduxGdp = json?.props?.pageProps?.initialReduxState?.gdp;
            return {
                hasGdpClientCache: !!componentProps?.gdpClientCache,
                gdpClientCacheKeys: componentProps?.gdpClientCache
                    ? Object.keys(JSON.parse(componentProps.gdpClientCache))
                    : null,
                hasReduxBuilding: !!initialReduxGdp?.building,
                buildingKeys: initialReduxGdp?.building ? Object.keys(initialReduxGdp.building).slice(0, 20) : null,
                subAppName: json?.props?.pageProps?.subAppName || null
            };
        } catch (e) {
            return { error: "JSON.parse failed: " + e.message };
        }
    });
    console.log(JSON.stringify(jsonProbe, null, 2));

    console.log(`\n=== STEP 6: Network summary ===`);
    console.log(`Blocked (image/css/font/media) requests: ${blockedRequests.length}`);
    console.log(`Allowed XHR/fetch requests: ${allowedXHR.length}`);
    if (allowedXHR.length > 0) {
        console.log("Sample XHR/fetch URLs (first 10):");
        allowedXHR.slice(0, 10).forEach(u => console.log("  " + u));
    }

    console.log(`\n=== STEP 7: Saving full page HTML + screenshot for manual inspection ===`);
    const html = await page.content();
    fs.writeFileSync('/tmp/zillow_debug_page.html', html);
    await page.screenshot({ path: '/tmp/zillow_debug_screenshot.png', fullPage: true });
    console.log("Saved: /tmp/zillow_debug_page.html and /tmp/zillow_debug_screenshot.png");

    await browser.close();

    console.log(`\n=== SUMMARY ===`);
    console.log(`Agent selector found via waitForSelector: ${agentSelectorFound}`);
    console.log(`Agent name found in DOM: ${domSnapshot.name.found}`);
    console.log(`Agent broker found in DOM: ${domSnapshot.broker.found}`);
    console.log(`__NEXT_DATA__ present: ${domSnapshot.hasNextDataNow}`);
}

diagnose();
