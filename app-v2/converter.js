const fs = require('fs-extra');
const path = require('path');
const readline = require('readline');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = require('docx');
const mammoth = require('mammoth');
const AdmZip = require('adm-zip');
const chalk = require('chalk');

// Base directory for your proofing files
const PROOFING_DIR = path.join(__dirname, 'output', 'proofing');

// Setup interactive CLI
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const ask = (question) => new Promise(resolve => rl.question(question, resolve));
const cleanInput = (str) => str.trim().replace(/^["']|["']$/g, '');

/**
 * Lists available books and lets the user select one
 */
async function getBookName(allowNew = false) {
    await fs.ensureDir(PROOFING_DIR);
    const entries = await fs.readdir(PROOFING_DIR, { withFileTypes: true });
    const books = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();

    if (books.length === 0 && !allowNew) {
        console.log(chalk.red('\n[Error] No books found in the proofing directory.'));
        return null;
    }

    console.log(chalk.cyan('\nAvailable books:'));
    books.forEach((book, index) => {
        console.log(chalk.white(`  ${index + 1}. ${book}`));
    });

    let promptText = '\nSelect a book by number';
    if (allowNew) {
        promptText += ' (or type "new" to create a new book folder)';
    }
    promptText += ' (or 0 to cancel): ';

    const choice = await ask(chalk.yellow(promptText));
    const trimmedChoice = choice.trim().toLowerCase();

    if (trimmedChoice === '0' || trimmedChoice === '') return null;

    if (allowNew && trimmedChoice === 'new') {
        const newName = cleanInput(await ask(chalk.blue('Enter new book folder name: ')));
        return newName || null;
    }

    const idx = parseInt(trimmedChoice, 10);
    if (isNaN(idx) || idx < 1 || idx > books.length) {
        console.log(chalk.red('Invalid selection.'));
        return null;
    }

    return books[idx - 1];
}

/**
 * Converts a single JSON file to a DOCX file with RTL support
 */
async function jsonToDocx(jsonPath, docxPath) {
    const data = await fs.readJson(jsonPath);
    const paragraphs = data.paragraphs || [];
    
    const docParagraphs = [];

    if (paragraphs.length > 0) {
        // Chapter Title (Heading 1)
        docParagraphs.push(new Paragraph({
            children: [new TextRun({ text: paragraphs[0], bold: true, size: 32, rightToLeft: true })],
            heading: HeadingLevel.HEADING_1,
            alignment: AlignmentType.RIGHT,
            bidirectional: true, // Crucial for correct Persian punctuation placement
            spacing: { after: 400 },
        }));

        // Normal paragraphs
        for (let i = 1; i < paragraphs.length; i++) {
            docParagraphs.push(new Paragraph({
                children: [new TextRun({ text: paragraphs[i], size: 24, rightToLeft: true })],
                alignment: AlignmentType.RIGHT,
                bidirectional: true, // Fixes RTL punctuation like «» and ،
                spacing: { after: 200 },
            }));
        }
    }

    const doc = new Document({
        sections: [{ children: docParagraphs }]
    });

    const buffer = await Packer.toBuffer(doc);
    await fs.writeFile(docxPath, buffer);
}

/**
 * Converts a single DOCX file to a JSON file
 */
async function docxToJson(docxPath, jsonPath) {
    const result = await mammoth.extractRawText({ path: docxPath });
    const text = result.value;
    
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const fileName = path.basename(docxPath, '.docx');

    const jsonData = {
        id: fileName,
        paragraphs: lines
    };

    await fs.writeJson(jsonPath, jsonData, { spaces: 2 });
}

/**
 * Exports all JSONs in a book folder to DOCX, then zips them
 */
async function exportBookToZip(bookName) {
    const bookDir = path.join(PROOFING_DIR, bookName);
    if (!await fs.pathExists(bookDir)) {
        return console.log(chalk.red(`\n[Error] Book directory not found at: ${bookDir}`));
    }

    const docxDir = path.join(bookDir, 'docx');
    await fs.ensureDir(docxDir);

    console.log(chalk.blue(`\nProcessing book: ${bookName}...`));
    
    // Filter out 'failed-chapters.json'
    const jsonFiles = (await fs.readdir(bookDir)).filter(f => f.endsWith('.json') && f !== 'failed-chapters.json');
    
    if (jsonFiles.length === 0) return console.log(chalk.yellow('No valid JSON files found in this folder.'));
    
    for (const file of jsonFiles) {
        const jsonPath = path.join(bookDir, file);
        const docxPath = path.join(docxDir, file.replace('.json', '.docx'));
        await jsonToDocx(jsonPath, docxPath);
        console.log(chalk.green(`  -> Converted: ${file}`));
    }

    // Create ZIP
    const zip = new AdmZip();
    const docxFiles = await fs.readdir(docxDir);
    for (const file of docxFiles) {
        zip.addLocalFile(path.join(docxDir, file));
    }

    const zipPath = path.join(PROOFING_DIR, `${bookName}.zip`);
    zip.writeZip(zipPath);
    console.log(chalk.cyan(`\n[Success] Exported ZIP to: ${zipPath}`));
}

/**
 * Imports DOCX files from a folder back to JSON
 */
async function importBookFromDocx(bookName) {
    const bookDir = path.join(PROOFING_DIR, bookName);
    const docxDir = path.join(bookDir, 'docx');
    const importDir = path.join(bookDir, 'imported_json');

    if (!await fs.pathExists(docxDir)) {
        return console.log(chalk.red(`\n[Error] DOCX directory not found at: ${docxDir}`));
    }

    await fs.ensureDir(importDir);
    console.log(chalk.blue(`\nImporting DOCX to JSON for book: ${bookName}...`));

    const docxFiles = (await fs.readdir(docxDir)).filter(f => f.endsWith('.docx'));
    if (docxFiles.length === 0) return console.log(chalk.yellow('No DOCX files found in this folder.'));

    for (const file of docxFiles) {
        const docxPath = path.join(docxDir, file);
        const jsonPath = path.join(importDir, file.replace('.docx', '.json'));
        await docxToJson(docxPath, jsonPath);
        console.log(chalk.green(`  -> Imported: ${file}`));
    }

    console.log(chalk.cyan(`\n[Success] Imported JSONs saved to: ${importDir}`));
}

/**
 * Imports a ZIP file, extracts it, and converts DOCX to JSON
 */
async function importFromZip(zipPath, bookName) {
    if (!await fs.pathExists(zipPath)) {
        return console.log(chalk.red(`\n[Error] ZIP file not found at: ${zipPath}`));
    }

    const bookDir = path.join(PROOFING_DIR, bookName);
    const docxDir = path.join(bookDir, 'docx');
    await fs.ensureDir(docxDir);

    console.log(chalk.blue(`\nExtracting ZIP: ${zipPath}...`));
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(docxDir, true);

    await importBookFromDocx(bookName);
}

// ==========================================
// Interactive CLI Menu
// ==========================================
async function showMenu() {
    console.log(chalk.cyan('\n====================================='));
    console.log(chalk.cyan('      Web Novel Converter CLI        '));
    console.log(chalk.cyan('====================================='));
    console.log(chalk.white('  1. Export Book to DOCX & ZIP'));
    console.log(chalk.white('  2. Import DOCX to JSON'));
    console.log(chalk.white('  3. Import from ZIP to JSON'));
    console.log(chalk.white('  4. Exit'));
    console.log(chalk.cyan('====================================='));

    try {
        const choice = await ask(chalk.yellow('\nSelect an option (1-4): '));

        switch (choice.trim()) {
            case '1': {
                const bookName = await getBookName(false);
                if (!bookName) break;
                await exportBookToZip(bookName);
                break;
            }
            case '2': {
                const bookName = await getBookName(false);
                if (!bookName) break;
                await importBookFromDocx(bookName);
                break;
            }
            case '3': {
                const zipPath = cleanInput(await ask(chalk.blue('Enter full path to the ZIP file: ')));
                if (!zipPath) { console.log(chalk.red('Path cannot be empty.')); break; }
                
                const bookName = await getBookName(true); // Allow creating a new book folder
                if (!bookName) break;
                
                await importFromZip(zipPath, bookName);
                break;
            }
            case '4':
                console.log(chalk.green('\nExiting converter. Goodbye!\n'));
                rl.close();
                process.exit(0);
                return;
            default:
                console.log(chalk.red('\nInvalid option. Please select 1, 2, 3, or 4.'));
        }
    } catch (error) {
        console.error(chalk.red('\nAn error occurred:'), error.message);
    }
    
    // Show menu again after action completes
    showMenu();
}

// Start the app
console.log(chalk.yellow('Starting Web Novel Converter...'));
showMenu();