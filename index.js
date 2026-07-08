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
// 2. CORE SCRAPER ENGINE (Zillow Rentals Edition)
// =========================================================
async function runScraper() {
    console.log("🚀 Starting Stealth Scraper V14 (Zillow Rentals with Dynamic Listed By)...");

    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    const serviceAccountAuth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];

    // Ensure we have enough columns for the expanded rental layout (up to Column X / index 23)
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
            await page.goto(originalUrl, { waitUntil: 'networkidle2', timeout: 30000 });

            const pageTitle = await page.title();
            if (pageTitle.includes("Pardon Our Interruption") || pageTitle.includes("Robot Check")) {
                console.log(`❌ BLOCKED: IP has been flagged on Row ${actualRowNumber}`);
                sheet.getCell(rowIndex, 23).value = "❌ BLOCKED (IP Burned)";
                await saveWithRetry(sheet);
                await page.close();
                continue;
            }

            // Wait for the "Listed by" element to appear (with timeout)
            let listedByText = "N/A";
            try {
                await page.waitForSelector('[data-testid="listing-agent-header"]', { timeout: 8000 });
                listedByText = await page.$eval('[data-testid="listing-agent-header"]', el => el.textContent.trim());
                console.log(`   📋 Listed by found: ${listedByText}`);
            } catch (waitError) {
                console.log(`   ⚠️ Listed by element not found within timeout - trying fallback selectors...`);
                // Fallback: try alternative selectors
                try {
                    listedByText = await page.$eval('.ds-listing-agent-header', el => el.textContent.trim());
                    console.log(`   📋 Listed by found via fallback: ${listedByText}`);
                } catch (fallbackError) {
                    console.log(`   ⚠️ Listed by element not found at all`);
                }
            }

            // 4. Extract Rental parameters from Next.js payload & Canonical Tag
            const extractedData = await page.evaluate((listedByText) => {
                let data = {
                    canonicalUrl: document.querySelector('meta[property="og:url"]')?.content || "",
                    propertyDetails: { price: "N/A", street: "N/A", city: "N/A", state: "N/A", zipcode: "N/A", beds: "N/A", baths: "N/A", type: "N/A" },
                    agentDetails: { name: "N/A", broker: "N/A", phone: "N/A", brokerPhone: "N/A", email: "N/A", listedBy: listedByText }
                };

                const nextDataScript = document.querySelector('script#__NEXT_DATA__');
                if (!nextDataScript) return data;

                try {
                    const jsonData = JSON.parse(nextDataScript.innerText);
                    const rawCache = jsonData?.props?.pageProps?.componentProps?.gdpClientCache;
                    if (!rawCache) return data;

                    const parsedCache = JSON.parse(rawCache);
                    
                    // Locate the rental specific query key
                    const cacheKey = Object.keys(parsedCache).find(key => parsedCache[key]?.property);
                    const p = parsedCache[cacheKey]?.property;
                    
                    if (!p) return data;

                    // Extrapolate Property Details
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

                    // Extrapolate Agent or FSBO Contact
                    if (p.attributionInfo) {
                        data.agentDetails = {
                            ...data.agentDetails,
                            name: p.attributionInfo.agentName || "N/A",
                            broker: p.attributionInfo.brokerName || "N/A",
                            phone: p.attributionInfo.agentPhoneNumber || "N/A",
                            brokerPhone: p.attributionInfo.brokerPhoneNumber || "N/A",
                            email: p.attributionInfo.agentEmail || "N/A"
                        };
                    } else if (p.postingContact) {
                        data.agentDetails.name = p.postingContact.name || "N/A";
                        data.agentDetails.phone = p.postingContact.phoneNumber || "N/A";
                    }

                } catch (e) {
                    // Swallow internal parse errors, return defaults
                }

                return data;
            }, listedByText); // Pass the extracted text into the evaluate function

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
            sheet.getCell(rowIndex, 18).value = extractedData.agentDetails.name;          // Col S: Agent/FSBO Name
            sheet.getCell(rowIndex, 19).value = extractedData.agentDetails.broker;        // Col T: Brokerage
            sheet.getCell(rowIndex, 20).value = extractedData.agentDetails.phone;         // Col U: Direct Phone
            sheet.getCell(rowIndex, 21).value = extractedData.agentDetails.email;         // Col V: Direct Email
            sheet.getCell(rowIndex, 22).value = extractedData.agentDetails.listedBy;      // Col W: Listed By
            sheet.getCell(rowIndex, 23).value = "✅ SUCCESS";                             // Col X: Status Tracker

            stagedCellsToSave.push(rowIndex);
            console.log(`   ✔️ Staged Row ${actualRowNumber} | Rent: ${extractedData.propertyDetails.price} | Bed/Bath: ${extractedData.propertyDetails.beds}/${extractedData.propertyDetails.baths}`);
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
