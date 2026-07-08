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
            return; // Success, break the retry loop
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
// 2. CORE SCRAPER ENGINE
// =========================================================
async function runScraper() {
    console.log("🚀 Starting Stealth Scraper V6 (Optimized Batch Edition)...");

    // Authenticate with Google Sheets using the single JSON secret
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    const serviceAccountAuth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];

    // Auto-expand columns if needed (Columns A through N)
    if (sheet.columnCount < 14) {
        console.log(`📏 Expanding sheet columns from ${sheet.columnCount} to 14...`);
        await sheet.resize({ rowCount: sheet.rowCount, columnCount: 14 });
    }

    // Load cell tracking window into memory
    await sheet.loadCells();

    // Launch Headless Browser
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    let scrapeCount = 0;
    let rowsRemaining = false;
    
    // Batch Configuration: Pushing to Google in small blocks avoids 500 timeouts
    const FLUSH_BATCH_SIZE = 10; 
    let stagedCellsToSave = [];

    // 3. Loop through rows (rowIndex = 1 skips the header)
    for (let rowIndex = 1; rowIndex < sheet.rowCount; rowIndex++) {

        const url = sheet.getCell(rowIndex, 0).value;
        const status = sheet.getCell(rowIndex, 13).value || "";

        if (!url) continue; // Skip empty rows
        if (!url.includes("zillow.com") || status.includes("✅")) continue; // Skip processed items

        // --- FRESH RUN LIMITER ---
        if (scrapeCount >= 30) {
            console.log("🛑 Reached 30 rows. Shutting down to rotate environment...");
            rowsRemaining = true;
            break;
        }

        const actualRowNumber = rowIndex + 1;
        console.log(`🕵️ Scraping Row ${actualRowNumber}: ${url}`);

        // Track running log via console, not cell values, to reduce API load
        const page = await browser.newPage();

        try {
            // --- SPEED BOOST: BLOCK HEAVY ASSETS ---
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
                    req.abort();
                } else {
                    req.continue();
                }
            });

            // Random delay navigation pacing
            await delay(Math.floor(Math.random() * 500) + 500);
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

            const pageTitle = await page.title();
            if (pageTitle.includes("Pardon Our Interruption") || pageTitle.includes("Robot Check")) {
                console.log(`❌ BLOCKED: IP has been flagged on Row ${actualRowNumber}`);
                sheet.getCell(rowIndex, 13).value = "❌ BLOCKED (IP Burned)";
                await saveWithRetry(sheet);
                await page.close();
                continue;
            }

            // 4. Extract MINIMAL details from Next.js state & JSON-LD
            const extractedData = await page.evaluate(() => {
                const formatPropertyType = (rawType) => {
                    if (!rawType) return "";
                    return rawType
                        .replace(/_/g, ' ')
                        .replace(/([a-z])([A-Z])/g, '$1 $2')
                        .toLowerCase()
                        .replace(/\b\w/g, char => char.toUpperCase());
                };

                // Extract strict County string from Breadcrumb Schema
                const extractCountyFromLD = () => {
                    const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
                    for (let script of scripts) {
                        try {
                            const data = JSON.parse(script.innerText);
                            if (data['@type'] === 'BreadcrumbList' && data.itemListElement) {
                                for (let el of data.itemListElement) {
                                    if (el.item && el.item.name && el.item.name.includes('County')) {
                                        return el.item.name;
                                    }
                                }
                            }
                        } catch (e) {}
                    }
                    return "";
                };

                const extractFromHomeDetail = (jsonData) => {
                    let data = { addr: "", propertyType: "", desc: "", county: "" };
                    const rawCache = jsonData?.props?.pageProps?.componentProps?.gdpClientCache;
                    if (!rawCache) return data;

                    try {
                        const parsedCache = JSON.parse(rawCache);
                        
                        // Dynamically find the key that holds the property object
                        const cacheKey = Object.keys(parsedCache).find(key => parsedCache[key]?.property);
                        const p = parsedCache[cacheKey]?.property;
                        
                        if (!p) return data;

                        data = {
                            addr: p.address?.streetAddress || "",
                            county: p.county || "", // Strict: no city fallback here
                            propertyType: formatPropertyType(p.homeType),
                            desc: p.description || ""
                        };
                    } catch (e) {}
                    return data;
                };

                const extractFromRentalBuilding = (jsonData) => {
                    let data = { addr: "", propertyType: "Apartment", desc: "", county: "" };
                    const building = jsonData?.props?.pageProps?.componentProps?.initialReduxState?.gdp?.building;
                    if (!building) return data;

                    data.addr = building.streetAddress || "";
                    data.county = building.county || ""; // Strict: no city fallback here
                    data.desc = building.description || "";
                    return data;
                };

                // Execution flow
                let result = { addr: "", propertyType: "", desc: "", county: "" };
                const nextDataScript = document.querySelector('script#__NEXT_DATA__');
                
                if (nextDataScript) {
                    try {
                        const jsonData = JSON.parse(nextDataScript.innerText);
                        result = extractFromHomeDetail(jsonData);
                        if (!result.addr) {
                            result = extractFromRentalBuilding(jsonData);
                        }
                    } catch (e) {}
                }

                // If Next.js state doesn't have the county, use the Breadcrumbs
                const ldCounty = extractCountyFromLD();
                if (ldCounty) {
                    result.county = ldCounty; 
                }

                return result;
            });

            // Stage variables to local layout memory cache
            sheet.getCell(rowIndex, 9).value = extractedData.addr;            // J
            sheet.getCell(rowIndex, 10).value = extractedData.propertyType;   // K
            sheet.getCell(rowIndex, 11).value = extractedData.desc;           // L
            sheet.getCell(rowIndex, 12).value = extractedData.county;         // M
            sheet.getCell(rowIndex, 13).value = "✅ SUCCESS";                 // N

            stagedCellsToSave.push(rowIndex);
            console.log(`✔️ Staged Row ${actualRowNumber} | 🏠 ${extractedData.propertyType || 'Unknown'} | 📍 ${extractedData.county || 'No County'}`);
            scrapeCount++;

        } catch (e) {
            console.error(`🛑 Error on Row ${actualRowNumber}: ${e.message}`);
            sheet.getCell(rowIndex, 13).value = "🛑 Error: " + e.message;
            stagedCellsToSave.push(rowIndex);
        } finally {
            await page.close();
        }

        // =========================================================
        // 5. PERIODIC BATCH WRITING
        // =========================================================
        if (stagedCellsToSave.length >= FLUSH_BATCH_SIZE) {
            console.log(`📦 Flashing batch of ${stagedCellsToSave.length} records to Google Sheets...`);
            await saveWithRetry(sheet);
            stagedCellsToSave = []; // Reset storage frame
        }
    }

    // Process leftover elements at loop termination
    if (stagedCellsToSave.length > 0) {
        console.log(`📦 Flashing final ${stagedCellsToSave.length} trailing records to Google Sheets...`);
        await saveWithRetry(sheet);
    }

    await browser.close();

    // 6. GITHUB ACTIONS CASCADE BRIDGE
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
