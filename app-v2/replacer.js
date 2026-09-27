const fs = require('fs-extra');
const path = require('path');
const readline = require('readline');
const chalk = require('chalk');

const PROOFING_DIR = path.join(__dirname, 'output', 'proofing');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const ask = (question) => new Promise(resolve => rl.question(question, resolve));

/**
 * Lists books and lets user pick one
 */
async function getBookName() {
    await fs.ensureDir(PROOFING_DIR);
    const entries = await fs.readdir(PROOFING_DIR, { withFileTypes: true });
    const books = entries.filter(e => e.isDirectory()).map(e => e.name).sort();

    if (books.length === 0) {
        console.log(chalk.red('\n[Error] No books found in proofing directory.'));
        return null;
    }

    console.log(chalk.cyan('\nAvailable books:'));
    books.forEach((book, i) => console.log(chalk.white(`  ${i + 1}. ${book}`)));

    const choice = await ask(chalk.yellow('\nSelect a book by number (0 to cancel): '));
    const idx = parseInt(choice.trim(), 10);
    if (isNaN(idx) || idx < 1 || idx > books.length) {
        console.log(chalk.red('Invalid selection.'));
        return null;
    }
    return books[idx - 1];
}

/**
 * Counts exact literal occurrences of a substring
 */
function countOccurrences(str, find) {
    if (!find) return 0;
    let count = 0;
    let pos = 0;
    while ((pos = str.indexOf(find, pos)) !== -1) {
        count++;
        pos += find.length;
    }
    return count;
}

/**
 * Main find & replace workflow
 */
async function runReplace() {
    const bookName = await getBookName();
    if (!bookName) return;

    const bookDir = path.join(PROOFING_DIR, bookName);
    const jsonFiles = (await fs.readdir(bookDir))
        .filter(f => f.endsWith('.json') && f !== 'failed-chapters.json')
        .sort();

    if (jsonFiles.length === 0) {
        console.log(chalk.yellow('\nNo chapter JSON files found in this book.'));
        return;
    }

    console.log(chalk.gray(`\nFound ${jsonFiles.length} chapter file(s).`));

    // --- Get search terms ---
    const findStr = await ask(chalk.blue('\nEnter the EXACT text to FIND: '));
    if (!findStr) {
        console.log(chalk.red('Find text cannot be empty.'));
        return;
    }

    const replaceStr = await ask(chalk.blue('Enter the text to REPLACE with (leave empty to delete): '));

    // ============================================
    // PHASE 1: SCAN & PREVIEW (Read-Only)
    // ============================================
    console.log(chalk.yellow('\n--- Scanning all chapters... ---\n'));

    const changes = []; // { file, paragraphIndex, before, after }
    let totalReplacements = 0;

    for (const file of jsonFiles) {
        const filePath = path.join(bookDir, file);
        const data = await fs.readJson(filePath);
        const paragraphs = data.paragraphs || [];

        for (let i = 0; i < paragraphs.length; i++) {
            const count = countOccurrences(paragraphs[i], findStr);
            if (count > 0) {
                const newParagraph = paragraphs[i].split(findStr).join(replaceStr);
                changes.push({
                    file,
                    paragraphIndex: i,
                    before: paragraphs[i],
                    after: newParagraph
                });
                totalReplacements += count;
            }
        }
    }

    if (changes.length === 0) {
        console.log(chalk.yellow(`\nNo occurrences of "${findStr}" found in any chapter.`));
        return;
    }

    // --- Show Preview ---
    console.log(chalk.cyan(`Found ${totalReplacements} occurrence(s) in ${changes.length} paragraph(s):\n`));

    const previewLimit = 25;
    for (let i = 0; i < Math.min(changes.length, previewLimit); i++) {
        const c = changes[i];
        console.log(chalk.gray(`  [${c.file}] line ${c.paragraphIndex + 1}:`));
        console.log(chalk.red(`    - ${c.before}`));
        console.log(chalk.green(`    + ${c.after}`));
        console.log();
    }

    if (changes.length > previewLimit) {
        console.log(chalk.gray(`  ... and ${changes.length - previewLimit} more paragraph(s) not shown.\n`));
    }

    console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log(chalk.cyan(`  Find:    "${findStr}"`));
    console.log(chalk.cyan(`  Replace: "${replaceStr}"`));
    console.log(chalk.cyan(`  Total:   ${totalReplacements} replacement(s) in ${changes.length} paragraph(s)`));
    console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

    // ============================================
    // PHASE 2: CONFIRM & APPLY
    // ============================================
    const confirm = await ask(chalk.yellow.bold('Apply these changes? This cannot be undone. (y/n): '));

    if (confirm.trim().toLowerCase() !== 'y') {
        console.log(chalk.gray('\nCancelled. No files were modified.'));
        return;
    }

    console.log(chalk.yellow('\nApplying changes...\n'));

    // Group changes by file to minimize disk writes
    const fileChanges = {};
    for (const c of changes) {
        if (!fileChanges[c.file]) fileChanges[c.file] = [];
        fileChanges[c.file].push(c);
    }

    for (const [file, fileChangeList] of Object.entries(fileChanges)) {
        const filePath = path.join(bookDir, file);
        const data = await fs.readJson(filePath);

        // ONLY modify the paragraphs array, nothing else
        for (const c of fileChangeList) {
            data.paragraphs[c.paragraphIndex] = c.after;
        }

        await fs.writeJson(filePath, data, { spaces: 2 });
        console.log(chalk.green(`  ✓ ${file} (${fileChangeList.length} change(s))`));
    }

    console.log(chalk.cyan.bold(`\n[Done] All ${totalReplacements} replacement(s) applied successfully!`));
}

// ==========================================
// Interactive CLI Menu
// ==========================================
async function showMenu() {
    console.log(chalk.cyan('\n====================================='));
    console.log(chalk.cyan('       Find & Replace Tool           '));
    console.log(chalk.cyan('====================================='));
    console.log(chalk.white('  1. Find & Replace in a Book'));
    console.log(chalk.white('  2. Exit'));
    console.log(chalk.cyan('====================================='));

    try {
        const choice = await ask(chalk.yellow('\nSelect an option (1-2): '));

        switch (choice.trim()) {
            case '1':
                await runReplace();
                break;
            case '2':
                console.log(chalk.green('\nGoodbye!\n'));
                rl.close();
                process.exit(0);
                return;
            default:
                console.log(chalk.red('\nInvalid option.'));
        }
    } catch (error) {
        console.error(chalk.red('\nError:'), error.message);
    }

    showMenu();
}

console.log(chalk.yellow('Starting Find & Replace Tool...'));
showMenu();