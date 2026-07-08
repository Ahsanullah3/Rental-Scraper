const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

// Enable stealth plugin to prevent detection
puppeteer.use(StealthPlugin());

// =========================================================
// 1. EXPONENTIAL BACKOFF (Google API 500 Error Fix)
// =========================================================
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function saveWithRetry(sheet, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            await sheet.saveUpdatedCells();
            return; 
        } catch (error) {
            if (i === retries - 1) {
                console.error("❌ Max retries reached. Google API remains unavailable.");
                throw error;
            }
            const waitTime = (2 ** i) * 1000;
            console.log(`⚠️ Google API 500/Timeout. Retrying in ${2 ** i} seconds...`);
            await delay(waitTime);
        }
    }
}

// =========================================================
// 2. CORE SCRAPER ENGINE (Zillow Rentals Edition + Lazy Load Fix)
// =========================================================
async function runScraper() {
    console.log("🚀 Starting Stealth Scraper V16 (Lazy-Load & JS Delay Fix)...");

    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    const serviceAccountAuth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];

    // Expanded to 24 columns for DOM fallbacks
    if (sheet.columnCount < 24) {
        console.log(`📏 Expanding sheet columns from ${sheet.columnCount} to 24...`);
        await sheet.resize({ rowCount: sheet.rowCount, columnCount: 24 });
    }

    await sheet.loadCells();

    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    let scrapeCount = 0;
    let rowsRemaining = false;
    const FLUSH_BATCH_SIZE = 10; 
    let stagedCellsToSave = [];

    // 3. Loop through rows (rowIndex = 1 skips the header)
    for (let rowIndex = 1; rowIndex < sheet.rowCount; rowIndex++) {

        const originalUrl = sheet.getCell(rowIndex, 0).value; 
        const status = sheet.getCell(rowIndex, 23).value || ""; // Status shifted to Column X (index 23)

        if (!originalUrl) continue; 
        if (!originalUrl.includes("zillow.com") || status.includes("✅")) continue; 

        if (scrapeCount >= 30) {
            console.log("🛑 Reached 30 rows. Shutting down to rotate runner environment...");
            rowsRemaining = true;
            break;
        }

        const actualRowNumber = rowIndex + 1;
        console.log(`\n🕵️ Scraping Row ${actualRowNumber}: ${originalUrl}`);

        const page = await browser.newPage();

        try {
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

            // FIX 1: Relaxed Interception (Allowed stylesheets to load so React hydrates properly)
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                if (['image', 'font', 'media'].includes(req.resourceType())) {
                    req.abort();
                } else {
                    req.continue();
                }
            });

            // FIX 2: Wait for network to quiet down, not just the HTML shell
            await page.goto(originalUrl, { waitUntil: 'networkidle2', timeout: 45000 });

            const pageTitle = await page.title();
            if (pageTitle.includes("Pardon Our Interruption") || pageTitle.includes("Robot Check")) {
                console.log(`❌ BLOCKED: IP has been flagged on Row ${actualRowNumber}`);
                sheet.getCell(rowIndex, 23).value = "❌ BLOCKED (IP Burned)";
                await saveWithRetry(sheet);
                await page.close();
                continue;
            }

            // FIX 3: Scroll down to trigger Zillow's JS lazy-loaders
            console.log("   📜 Scrolling to trigger lazy-loaded elements...");
            await page.evaluate(async () => {
                await new Promise((resolve) => {
                    let totalHeight = 0;
                    const distance = 300;
                    const timer = setInterval(() => {
                        window.scrollBy(0, distance);
                        totalHeight += distance;
                        if (totalHeight >= 3000 || totalHeight >= document.body.scrollHeight) {
                            clearInterval(timer);
                            resolve();
                        }
                    }, 100);
                });
            });

            // FIX 4: The Golden Delay. Give Javascript time to render the DOM.
            console.log("   ⏳ Waiting 2.5 seconds for Javascript data to populate...");
            await delay(2500);

            // 4. Extract Rental parameters from Next.js payload & Canonical Tag
            const extractedData = await page.evaluate(() => {
                let data = {
                    canonicalUrl: document.querySelector('meta[property="og:url"]')?.content || "",
                    propertyDetails: { price: "N/A", street: "N/A", city: "N/A", state: "N/A", zipcode: "N/A", beds: "N/A", baths: "N/A", type: "N/A" },
                    agentDetails: { listedByType: "N/A", name: "N/A", broker: "N/A", phone: "N/A", brokerPhone: "N/A", email: "N/A" }
                };

                const nextDataScript = document.querySelector('script#__NEXT_DATA__');

                // --- PRIMARY EXTRACTION: RENTALS / BUILDING CACHE ---
                if (nextDataScript) {
                    try {
                        const jsonData = JSON.parse(nextDataScript.innerText);

                        try {
                            const rawCache = jsonData?.props?.pageProps?.componentProps?.gdpClientCache;
                            if (rawCache) {
                                const parsedCache = typeof rawCache === 'string' ? JSON.parse(rawCache) : rawCache;
                                const cacheKey = Object.keys(parsedCache).find(key => parsedCache[key]?.property);
                                const p = parsedCache[cacheKey]?.property;
                                
                                if (p) {
                                    data.propertyDetails = {
                                        price: p.price || p.baseRent || "N/A",
                                        street: p.address?.streetAddress || p.streetAddress || "N/A",
                                        city: p.address?.city || p.city || "N/A",
                                        state: p.address?.state || p.state || "N/A",
                                        zipcode: p.address?.zipcode || p.zipcode || "N/A",
                                        beds: p.bedrooms ?? "N/A",
                                        baths: p.bathrooms ?? "N/A",
                                        type: p.homeType || "N/A"
                                    };

                                    if (p.attributionInfo) {
                                        if(p.attributionInfo.agentName) data.agentDetails.name = p.attributionInfo.agentName;
                                        if(p.attributionInfo.brokerName) data.agentDetails.broker = p.attributionInfo.brokerName;
                                        data.agentDetails.phone = p.attributionInfo.agentPhoneNumber || "N/A";
                                        data.agentDetails.brokerPhone = p.attributionInfo.brokerPhoneNumber || "N/A";
                                        data.agentDetails.email = p.attributionInfo.agentEmail || "N/A";
                                    } else if (p.postingContact) {
                                        if(p.postingContact.name) data.agentDetails.name = p.postingContact.name;
                                        data.agentDetails.phone = p.postingContact.phoneNumber || "N/A";
                                    }
                                }
                            }
                        } catch(e) {}

                        // Building Fallback
                        try {
                            const gdpBuilding = jsonData?.props?.pageProps?.initialReduxState?.gdp?.building;
                            if (gdpBuilding && data.propertyDetails.price === "N/A") {
                                const firstUnit = gdpBuilding.ungroupedUnits?.[0] || {};
                                
                                data.propertyDetails = {
                                    price: firstUnit.price || firstUnit.baseRent || "N/A",
                                    street: gdpBuilding.address?.streetAddress || "N/A",
                                    city: gdpBuilding.address?.city || "N/A",
                                    state: gdpBuilding.address?.state || "N/A",
                                    zipcode: gdpBuilding.address?.zipcode || "N/A",
                                    beds: firstUnit.beds ?? "N/A",
                                    baths: firstUnit.baths ?? "N/A",
                                    type: gdpBuilding.buildingType || "Building"
                                };

                                if (data.agentDetails.name === "N/A" && gdpBuilding.contactInfo?.agentFullName) {
                                    data.agentDetails.name = gdpBuilding.contactInfo.agentFullName;
                                }
                                if (data.agentDetails.phone === "N/A" && gdpBuilding.contactInfo?.agentPhoneNumber) {
                                    data.agentDetails.phone = gdpBuilding.contactInfo.agentPhoneNumber;
                                }
                            }
                        } catch(e) {}

                    } catch (e) {}
                }

                // --- FINAL OVERRIDE: DIRECT DOM EXTRACTION ---
                // Grabs the data after the lazy-load delay and overwrites the JSON
                try {
                    const headerEl = document.querySelector('[data-testid="listing-agent-header"]');
                    if (headerEl && headerEl.innerText.trim() !== "") {
                        data.agentDetails.listedByType = headerEl.innerText.trim();
                    }

                    const domNameEl = document.querySelector('.ds-listing-agent-display-name');
                    if (domNameEl && domNameEl.innerText.trim() !== "") {
                        data.agentDetails.name = domNameEl.innerText.trim();
                    }

                    const domBrokerEl = document.querySelector('.ds-listing-agent-business-name');
                    if (domBrokerEl && domBrokerEl.innerText.trim() !== "") {
                        data.agentDetails.broker = domBrokerEl.innerText.trim();
                    }
                } catch(e) {}

                return data;
            });

            const finalUrl = extractedData.canonicalUrl || originalUrl;

            // 5. Rental Layout Memory Map (Columns J through X)
            sheet.getCell(rowIndex, 9).value = extractedData.propertyDetails.price;       // Col J: Rent / Price
            sheet.getCell(rowIndex, 10).value = extractedData.propertyDetails.street;     // Col K: Street
            sheet.getCell(rowIndex, 11).value = extractedData.propertyDetails.city;       // Col L: City
            sheet.getCell(rowIndex, 12).value = extractedData.propertyDetails.state;      // Col M: State
            sheet.getCell(rowIndex, 13).value = extractedData.propertyDetails.zipcode;    // Col N: Zipcode
            sheet.getCell(rowIndex, 14).value = extractedData.propertyDetails.beds;       // Col O: Beds
            sheet.getCell(rowIndex, 15).value = extractedData.propertyDetails.baths;      // Col P: Baths
            sheet.getCell(rowIndex, 16).value = extractedData.propertyDetails.type;       // Col Q: Type
            sheet.getCell(rowIndex, 17).value = finalUrl;                                 // Col R: Zillow Link
            sheet.getCell(rowIndex, 18).value = extractedData.agentDetails.listedByType;  // Col S: Listed By (DOM Fallback)
            sheet.getCell(rowIndex, 19).value = extractedData.agentDetails.name;          // Col T: Agent/FSBO Name
            sheet.getCell(rowIndex, 20).value = extractedData.agentDetails.broker;        // Col U: Brokerage
            sheet.getCell(rowIndex, 21).value = extractedData.agentDetails.phone;         // Col V: Direct Phone
            sheet.getCell(rowIndex, 22).value = extractedData.agentDetails.email;         // Col W: Direct Email
            sheet.getCell(rowIndex, 23).value = "✅ SUCCESS";                             // Col X: Status Tracker

            stagedCellsToSave.push(rowIndex);
            console.log(`   ✔️ Staged Row ${actualRowNumber} | Rent: ${extractedData.propertyDetails.price} | Listed By: ${extractedData.agentDetails.listedByType}`);
            scrapeCount++;

        } catch (e) {
            console.error(`   🛑 Error on Row ${actualRowNumber}: ${e.message}`);
            sheet.getCell(rowIndex, 23).value = "🛑 Error: " + e.message;
            stagedCellsToSave.push(rowIndex);
        } finally {
            if (page) await page.close();
        }

        // =========================================================
        // 6. PERIODIC BATCH WRITING
        // =========================================================
        if (stagedCellsToSave.length >= FLUSH_BATCH_SIZE) {
            console.log(`📦 Flashing batch of ${stagedCellsToSave.length} records to Google Sheets...`);
            await saveWithRetry(sheet);
            stagedCellsToSave = []; 
        }
    }

    if (stagedCellsToSave.length > 0) {
        console.log(`📦 Flashing final ${stagedCellsToSave.length} trailing records to Google Sheets...`);
        await saveWithRetry(sheet);
    }

    await browser.close();

    // 7. GITHUB ACTIONS CASCADE BRIDGE
    if (process.env.GITHUB_OUTPUT) {
        if (rowsRemaining) {
            fs.appendFileSync(process.env.GITHUB_OUTPUT, "has_more=true\n");
            console.log("🔄 Remaining links found. Relaying trigger token to runner pipeline...");
        } else {
            fs.appendFileSync(process.env.GITHUB_OUTPUT, "has_more=false\n");
            console.log("🎉 Entire sheet processing execution completed!");
        }
    }
}

runScraper();
