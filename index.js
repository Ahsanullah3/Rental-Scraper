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
// 2. CORE SCRAPER ENGINE (Zillow Rentals w/ Direct Fallbacks)
// =========================================================
async function runScraper() {
    console.log("🚀 Starting Stealth Scraper V14 (Agent-Card-Wait Fix)...");

    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    const serviceAccountAuth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];

    // Expanded to 24 to add "Listed By Type" (DOM Fallback)
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

        const originalUrl = sheet.getCell(rowIndex, 0).value; // Assuming links are in Column A
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
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
                    req.abort();
                } else {
                    req.continue();
                }
            });

            await delay(Math.floor(Math.random() * 500) + 500);
            await page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

            const pageTitle = await page.title();
            if (pageTitle.includes("Pardon Our Interruption") || pageTitle.includes("Robot Check")) {
                console.log(`❌ BLOCKED: IP has been flagged on Row ${actualRowNumber}`);
                sheet.getCell(rowIndex, 23).value = "❌ BLOCKED (IP Burned)";
                await saveWithRetry(sheet);
                await page.close();
                continue;
            }

            // ---------------------------------------------------------
            // 3a. WAIT FOR THE LISTING-AGENT CARD TO HYDRATE
            // The agent card (.ds-listing-agent-*) is often rendered
            // client-side AFTER domcontentloaded fires. Without this
            // wait, page.evaluate() runs too early and the agent
            // name/broker come back blank even though they exist.
            // Bounded timeout so FSBO / no-agent listings don't hang.
            // ---------------------------------------------------------
            try {
                await page.waitForSelector(
                    '[data-testid="listing-agent-container"], .ds-listing-agent-display-name, .ds-listing-agent-business-name',
                    { timeout: 8000 }
                );
            } catch (waitErr) {
                console.log(`   ⏳ No agent card detected within timeout on Row ${actualRowNumber} (may be FSBO or slow render).`);
            }

            // Small extra settle time in case the name/broker spans
            // populate a beat after the container itself appears.
            await delay(400);

            // 4. Extract Rental parameters from Next.js payload, DOM, and Redux Fallback
            const extractedData = await page.evaluate(() => {
                let data = {
                    canonicalUrl: document.querySelector('meta[property="og:url"]')?.content || "",
                    propertyDetails: { price: "N/A", street: "N/A", city: "N/A", state: "N/A", zipcode: "N/A", beds: "N/A", baths: "N/A", type: "N/A" },
                    agentDetails: { listedByType: "N/A", name: "N/A", broker: "N/A", phone: "N/A", brokerPhone: "N/A", email: "N/A" }
                };

                // --- FALLBACK 1: DIRECT DOM EXTRACTION (now hydration-safe) ---
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

                    // Some listings render a phone number as a further
                    // <li> or <a href="tel:..."> inside the agent info list.
                    const telAnchor = document.querySelector('[data-testid="listing-agent-container"] a[href^="tel:"]');
                    if (telAnchor) {
                        const rawTel = telAnchor.getAttribute('href').replace('tel:', '').trim();
                        if (rawTel) data.agentDetails.phone = rawTel;
                    }
                } catch (e) {}

                const nextDataScript = document.querySelector('script#__NEXT_DATA__');
                if (!nextDataScript) return data;

                try {
                    const jsonData = JSON.parse(nextDataScript.innerText);

                    // --- ROUTE 1: SINGLE-LISTING RENTALS EXTRACTION ---
                    try {
                        const rawCache = jsonData?.props?.pageProps?.componentProps?.gdpClientCache;
                        if (rawCache) {
                            const parsedCache = JSON.parse(rawCache);

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

                                // Only overwrite DOM-derived agent info if JSON has it
                                // and the DOM pass didn't already find something.
                                if (p.attributionInfo) {
                                    if (data.agentDetails.name === "N/A" && p.attributionInfo.agentName) {
                                        data.agentDetails.name = p.attributionInfo.agentName;
                                    }
                                    if (data.agentDetails.broker === "N/A" && p.attributionInfo.brokerName) {
                                        data.agentDetails.broker = p.attributionInfo.brokerName;
                                    }
                                    if (data.agentDetails.phone === "N/A") {
                                        data.agentDetails.phone = p.attributionInfo.agentPhoneNumber || "N/A";
                                    }
                                    data.agentDetails.brokerPhone = p.attributionInfo.brokerPhoneNumber || "N/A";
                                    data.agentDetails.email = p.attributionInfo.agentEmail || "N/A";
                                } else if (p.postingContact) {
                                    if (data.agentDetails.name === "N/A" && p.postingContact.name) {
                                        data.agentDetails.name = p.postingContact.name;
                                    }
                                    if (data.agentDetails.phone === "N/A") {
                                        data.agentDetails.phone = p.postingContact.phoneNumber || "N/A";
                                    }
                                }
                            }
                        }
                    } catch (e) {}

                    // --- FALLBACK 2: BUILDING / APARTMENT-COMMUNITY PAGES ---
                    // Only applies if Route 1 failed to grab a price
                    try {
                        const gdpBuilding = jsonData?.props?.pageProps?.initialReduxState?.gdp?.building;
                        if (gdpBuilding && data.propertyDetails.price === "N/A") {
                            let firstUnit = null;
                            if (Array.isArray(gdpBuilding.ungroupedUnits) && gdpBuilding.ungroupedUnits.length) {
                                firstUnit = gdpBuilding.ungroupedUnits[0];
                            } else if (Array.isArray(gdpBuilding.floorPlans) && gdpBuilding.floorPlans.length) {
                                const fp = gdpBuilding.floorPlans[0];
                                firstUnit = (fp.units && fp.units[0]) || fp;
                            }
                            firstUnit = firstUnit || {};

                            data.propertyDetails = {
                                price: firstUnit.price ?? firstUnit.baseRent ?? "N/A",
                                street: gdpBuilding.address?.streetAddress || gdpBuilding.streetAddress || "N/A",
                                city: gdpBuilding.address?.city || gdpBuilding.city || "N/A",
                                state: gdpBuilding.address?.state || gdpBuilding.state || "N/A",
                                zipcode: gdpBuilding.address?.zipcode || gdpBuilding.zipcode || "N/A",
                                beds: firstUnit.beds ?? "N/A",
                                baths: firstUnit.baths ?? "N/A",
                                type: gdpBuilding.buildingType || "Building"
                            };

                            if (data.agentDetails.name === "N/A" && gdpBuilding.contactInfo?.agentFullName) {
                                data.agentDetails.name = gdpBuilding.contactInfo.agentFullName;
                            }
                            if (data.agentDetails.phone === "N/A") {
                                data.agentDetails.phone = gdpBuilding.contactInfo?.agentPhoneNumber
                                    || gdpBuilding.buildingPhoneNumber
                                    || "N/A";
                            }
                            // Management company is often only in free-text description
                            if (data.agentDetails.broker === "N/A" && gdpBuilding.description) {
                                const mgmtMatch = gdpBuilding.description.match(
                                    /(?:managed by|Listed by)\s+([A-Z][A-Za-z0-9&.,'\s]+?)(?:[.\n]|$)/i
                                );
                                if (mgmtMatch) data.agentDetails.broker = mgmtMatch[1].trim();
                            }
                        }
                    } catch (e) {}

                } catch (e) {
                    // Swallow internal parse errors, return defaults
                }

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
            sheet.getCell(rowIndex, 16).value = extractedData.propertyDetails.type;       // Col Q: Type (Apt, Condo, etc)
            sheet.getCell(rowIndex, 17).value = finalUrl;                                 // Col R: Zillow Link
            sheet.getCell(rowIndex, 18).value = extractedData.agentDetails.listedByType;  // Col S: Listed By (DOM Fallback)
            sheet.getCell(rowIndex, 19).value = extractedData.agentDetails.name;          // Col T: Agent/FSBO Name
            sheet.getCell(rowIndex, 20).value = extractedData.agentDetails.broker;        // Col U: Brokerage
            sheet.getCell(rowIndex, 21).value = extractedData.agentDetails.phone;         // Col V: Direct Phone
            sheet.getCell(rowIndex, 22).value = extractedData.agentDetails.email;         // Col W: Direct Email
            sheet.getCell(rowIndex, 23).value = "✅ SUCCESS";                             // Col X: Status Tracker

            stagedCellsToSave.push(rowIndex);
            console.log(`   ✔️ Staged Row ${actualRowNumber} | Rent: ${extractedData.propertyDetails.price} | Agent: ${extractedData.agentDetails.name} | Broker: ${extractedData.agentDetails.broker}`);
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
