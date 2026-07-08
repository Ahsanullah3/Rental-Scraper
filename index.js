const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

// Enable stealth plugin
puppeteer.use(StealthPlugin());

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// =========================================================
// 1. EXPONENTIAL BACKOFF (Google API 500 Error Fix)
// =========================================================
async function saveWithRetry(sheet, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            await sheet.saveUpdatedCells();
            return; 
        } catch (error) {
            if (i === retries - 1) {
                console.error("❌ Max retries reached. Google API unavailable.");
                throw error;
            }
            console.log(`⚠️ Google API Retry in ${2 ** i} seconds...`);
            await delay((2 ** i) * 1000);
        }
    }
}

// =========================================================
// 2. CORE SCRAPER ENGINE (V15: Hardened Dual-Payload)
// =========================================================
async function runScraper() {
    console.log("🚀 Starting Stealth Scraper V15 (Hardened Building & Rentals Engine)...");

    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    const serviceAccountAuth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];

    // Expanded to 24 columns to accommodate the new "Listed By Type" field
    if (sheet.columnCount < 24) {
        await sheet.resize({ rowCount: sheet.rowCount, columnCount: 24 });
    }

    await sheet.loadCells();

    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
    });

    let scrapeCount = 0;
    let rowsRemaining = false;
    const FLUSH_BATCH_SIZE = 10; 
    let stagedCellsToSave = [];

    // 3. ROW EXECUTION LOOP
    for (let rowIndex = 1; rowIndex < sheet.rowCount; rowIndex++) {
        const originalUrl = sheet.getCell(rowIndex, 0).value; 
        const status = sheet.getCell(rowIndex, 23).value || ""; // Status shifted to Col X (Index 23)

        if (!originalUrl || !originalUrl.includes("zillow.com") || status.includes("✅")) continue; 

        if (scrapeCount >= 30) {
            console.log("🛑 Reached 30 rows. Rotating runner environment...");
            rowsRemaining = true;
            break;
        }

        const actualRowNumber = rowIndex + 1;
        console.log(`\n🕵️ Scraping Row ${actualRowNumber}: ${originalUrl}`);

        const page = await browser.newPage();

        try {
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
                    req.abort();
                } else {
                    req.continue();
                }
            });

            await page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

            const pageTitle = await page.title();
            if (pageTitle.includes("Pardon Our Interruption") || pageTitle.includes("Robot Check")) {
                throw new Error("BLOCKED (IP Burned)");
            }

            // 4. DUAL-PAYLOAD EXTRACTION ENGINE (Hardened & Decoupled)
            const extractedData = await page.evaluate(() => {
                let data = {
                    canonicalUrl: document.querySelector('meta[property="og:url"]')?.content || "",
                    propertyDetails: { price: "N/A", street: "N/A", city: "N/A", state: "N/A", zipcode: "N/A", beds: "N/A", baths: "N/A", type: "N/A" },
                    agentDetails: { listedByType: "N/A", name: "N/A", broker: "N/A", phone: "N/A", brokerPhone: "N/A", email: "N/A" },
                    debugLog: "Clean"
                };

                // --- A. DIRECT DOM EXTRACTION ---
                try {
                    const headerEl = document.querySelector('[data-testid="listing-agent-header"]');
                    if (headerEl) data.agentDetails.listedByType = headerEl.innerText.trim();

                    const domNameEl = document.querySelector('.ds-listing-agent-display-name');
                    if (domNameEl) data.agentDetails.name = domNameEl.innerText.trim();

                    const domBrokerEl = document.querySelector('.ds-listing-agent-business-name');
                    if (domBrokerEl && domBrokerEl.innerText.trim() !== "") data.agentDetails.broker = domBrokerEl.innerText.trim();
                } catch(e) { data.debugLog = "DOM Error; "; }

                // --- B. NEXT.JS HYDRATION PARSING ---
                const nextDataScript = document.querySelector('script#__NEXT_DATA__');
                if (!nextDataScript) {
                    data.debugLog += "No __NEXT_DATA__ found.";
                    return data;
                }

                let jsonData;
                try {
                    jsonData = JSON.parse(nextDataScript.innerText);
                } catch(e) {
                    data.debugLog += "Fatal: Failed to parse main __NEXT_DATA__ script.";
                    return data;
                }

                // Route 1: Standard Rentals Cache (Isolated Try/Catch)
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

                            if (data.agentDetails.name === "N/A") {
                                data.agentDetails.name = p.attributionInfo?.agentName || p.postingContact?.name || "N/A";
                            }
                            data.agentDetails.phone = p.attributionInfo?.agentPhoneNumber || p.postingContact?.phoneNumber || "N/A";
                            data.agentDetails.email = p.attributionInfo?.agentEmail || "N/A";
                            if (data.agentDetails.broker === "N/A") data.agentDetails.broker = p.attributionInfo?.brokerName || "N/A";
                        }
                    }
                } catch (e) {
                    data.debugLog += `Route 1 Error: ${e.message}; `;
                }

                // Route 2: Building Page Sub-App Payload (Isolated Try/Catch)
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

                        if (data.agentDetails.name === "N/A") {
                            data.agentDetails.name = gdpBuilding.contactInfo?.agentFullName || "N/A";
                        }
                        if (data.agentDetails.phone === "N/A") {
                            data.agentDetails.phone = gdpBuilding.contactInfo?.agentPhoneNumber || "N/A";
                        }
                    }
                } catch (e) {
                    data.debugLog += `Route 2 Error: ${e.message}; `;
                }

                return data;
            });

            // Log the debugging tracer
            if (extractedData.debugLog !== "Clean") {
                console.log(`   ⚠️ UI Extraction Trace: ${extractedData.debugLog}`);
            }

            const finalUrl = extractedData.canonicalUrl || originalUrl;

            // 5. LAYOUT MEMORY MAP (Columns J through X)
            sheet.getCell(rowIndex, 9).value = extractedData.propertyDetails.price;       // Col J
            sheet.getCell(rowIndex, 10).value = extractedData.propertyDetails.street;     // Col K
            sheet.getCell(rowIndex, 11).value = extractedData.propertyDetails.city;       // Col L
            sheet.getCell(rowIndex, 12).value = extractedData.propertyDetails.state;      // Col M
            sheet.getCell(rowIndex, 13).value = extractedData.propertyDetails.zipcode;    // Col N
            sheet.getCell(rowIndex, 14).value = extractedData.propertyDetails.beds;       // Col O
            sheet.getCell(rowIndex, 15).value = extractedData.propertyDetails.baths;      // Col P
            sheet.getCell(rowIndex, 16).value = extractedData.propertyDetails.type;       // Col Q
            sheet.getCell(rowIndex, 17).value = finalUrl;                                 // Col R
            
            // Agent Layout
            sheet.getCell(rowIndex, 18).value = extractedData.agentDetails.listedByType;  // Col S
            sheet.getCell(rowIndex, 19).value = extractedData.agentDetails.name;          // Col T 
            sheet.getCell(rowIndex, 20).value = extractedData.agentDetails.broker;        // Col U
            sheet.getCell(rowIndex, 21).value = extractedData.agentDetails.phone;         // Col V
            sheet.getCell(rowIndex, 22).value = extractedData.agentDetails.email;         // Col W
            sheet.getCell(rowIndex, 23).value = "✅ SUCCESS";                             // Col X: Status Tracker

            stagedCellsToSave.push(rowIndex);
            console.log(`   ✔️ Staged Row ${actualRowNumber} | Rent: ${extractedData.propertyDetails.price} | Listed By: ${extractedData.agentDetails.listedByType} (${extractedData.agentDetails.name})`);
            scrapeCount++;

        } catch (e) {
            console.error(`   🛑 Error on Row ${actualRowNumber}: ${e.message}`);
            sheet.getCell(rowIndex, 23).value = "🛑 Error: " + e.message;
            stagedCellsToSave.push(rowIndex);
        } finally {
            if (page) await page.close();
        }

        // 6. PERIODIC BATCH WRITING
        if (stagedCellsToSave.length >= FLUSH_BATCH_SIZE) {
            console.log(`📦 Flashing batch of ${stagedCellsToSave.length} records to Google Sheets...`);
            await saveWithRetry(sheet);
            stagedCellsToSave = []; 
        }
    }

    if (stagedCellsToSave.length > 0) {
        console.log(`📦 Flashing final ${stagedCellsToSave.length} trailing records...`);
        await saveWithRetry(sheet);
    }

    await browser.close();

    // 7. GITHUB ACTIONS CASCADE BRIDGE
    if (process.env.GITHUB_OUTPUT) {
        if (rowsRemaining) {
            fs.appendFileSync(process.env.GITHUB_OUTPUT, "has_more=true\n");
            console.log("🔄 Trigger token passed to runner pipeline.");
        } else {
            fs.appendFileSync(process.env.GITHUB_OUTPUT, "has_more=false\n");
            console.log("🎉 Execution completed!");
        }
    }
}

runScraper();
