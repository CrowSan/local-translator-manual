```markdown
# 📚 Local Translator (AI-Powered Book Translation)

A powerful Node.js tool that translates large English markdown/text books into Persian (Farsi) using online AI chatbots (Gemini & DeepSeek) via local browser automation. It supports chunking, glossary enforcement, editorial refinement, and JSON export for structured data.

## ✨ Features

- **🤖 Dual AI Engines**: Supports **Gemini** (Flash-Lite optimized) and **DeepSeek**.
- **📖 Two Modes**:
  1.  **Translation Mode**: Translates raw chapters from `input/` to `output/`.
  2.  **Editing Mode**: Refines already translated text, converts the final output to structured **JSON** `{ id, paragraphs }` for clean data integration.
- **📝 Smart Chunking**: Splits large chapters into 3000-word chunks to avoid context limits, maintaining coherence.
- **📖 Glossary Support**: Enforces specific term translations per book (e.g., character names, technical jargon).
- **⚡ Parallel Processing**: Processes up to **4 chapters simultaneously** per book, supporting **1 to 2 books** in parallel for maximum speed.
- **🎨 Custom Prompts**: Stores translation and editorial instructions in separate `.txt` files inside the `prompts/` directory.
- **🔒 Local Chrome Only**: Uses your existing Chrome installation with persistent profiles. No remote API keys required (saves costs!).
- **📄 Output Formats**: Standard Markdown for translation results, and **structured JSON** for the final editorial pass.

## 🛠️ Prerequisites

Before you begin, ensure you have the following installed:

1.  **[Node.js](https://nodejs.org/)** (v16 or higher recommended).
2.  **[Google Chrome](https://www.google.com/chrome/)** (installed at the default path `C:\Program Files\Google\Chrome\Application\chrome.exe`).
3.  **[Git](https://git-scm.com/)** (optional, for version control).

## 🚀 Installation

1.  **Clone or download** this repository to your local machine.
2.  Open a terminal in the project root directory.
3.  Install the required Node.js dependencies:

```bash
npm install playwright
```

*(Note: Playwright will download its browser binaries, but we connect to your **existing** Chrome instance instead of using Playwright's default).*

## 📂 Project Structure

Create the following folders in your project root:

```
local-translator/
├── input/               # Place your raw books here (each book as a separate folder)
│   └── my_book/
│       ├── chapter_01.md
│       ├── chapter_02.md
│       └── glossary.txt # Optional: en -> fa terms per book
├── output/              # Translated files are saved here
│   └── my_book/
│       ├── chapter_01.md (translated)
│       └── ...          # (If Editing Mode is run, output/edited/my_book/)
├── prompts/             # Store your prompt templates
│   └── default.txt      # Must contain "translation_prompt:" and/or "editorial_prompt:"
├── to-html.js           # (Optional helper file, if present)
├── translate.js         # <-- Main execution script
└── README.md
```

## ⚙️ Configuration

### 1. Prompts (`prompts/` folder)
Create a `.txt` file (e.g., `default.txt`) in the `prompts` folder. It must contain one or both of the following sections:

```text
translation_prompt:
You are a professional translator. Translate the following text from English to Persian (Farsi). Keep the tone formal and use the provided glossary. Only output the translation.

editorial_prompt:
You are a senior editor. Edit the following translated text to improve readability, fix grammar, and ensure stylistic consistency. Only output the final edited text.
```

### 2. Glossary (Optional)
Place a `glossary.txt` inside your specific book folder in `input/` (e.g., `input/my_book/glossary.txt`). Use the format:
```text
Magic -> جادو
Sword -> شمشیر
Frodo -> فرودو
```

### 3. Chrome Setup
The script automatically launches your local Chrome with a specific persistent profile (`C:\chrome-dev-profile`). This ensures you stay logged into Gemini/DeepSeek.

> **Warning**: Make sure you are **already logged into** Gemini or DeepSeek in your regular Chrome browser, or this profile will ask you to log in on the first run.

## 🎮 How to Use

Run the main script in your terminal:

```bash
node translate.js
```

### Mode 1: Translation (Input → Output)

1.  **Select Mode**: Choose `1` for Translation.
2.  **Select Books**: The script scans the `input/` folder. Select the book folder and specify chapter ranges (e.g., `all`, `5-10`, or `1,3,5-7`).
3.  **Select AI Bot**: Choose `1` for Gemini or `2` for DeepSeek.
4.  **Select Prompt**: Choose the prompt template you created in the `prompts/` folder.
5.  **Editorial Pass**: Decide whether to apply the editorial pass immediately after translation (`y/n`).
6.  **Sit Back**: The script will open your Chrome window, navigate to the AI, paste the prompts, wait for responses, and save the files to `output/`.

### Mode 2: Editing (Output → Output/Edited/JSON)

This mode skips translation and focuses purely on polishing already translated files (located in `output/`).

1.  **Select Mode**: Choose `2` for Editing.
2.  **Select Book**: Choose from the books available in your `output/` folder.
3.  **Select Bot & Prompt**: Choose the editorial prompt you want to use.
4.  **Result**: The script will process the text, run it through the editorial instructions, and save the final result as a **JSON file** in `output/edited/your_book/`.

   *JSON Format Example:*
   ```json
   {
     "id": "my_book_00001",
     "paragraphs": ["First paragraph text.", "Second paragraph text."]
   }
   ```

## ⚠️ Important Notes

- **Proxy Bypass**: The script bypasses local proxies (`NO_PROXY=localhost,127.0.0.1`) to ensure Playwright can connect to your Chrome instance without interference.
- **Concurrency Limit**: The script runs **4 tabs per book** and allows **2 books simultaneously** (`TABS_PER_BOOK = 4`). Adjust this in the source if your PC can handle more or needs less.
- **Bypassing Paywalls/Logins**: This tool automates *your own* browser. It is intended for personal, non-commercial use with your logged-in accounts. Please respect the AI services' Terms of Service.
- **Network Throttling**: The script includes a 20-second delay (`MESSAGE_DELAY`) between chunks to avoid overwhelming the AI services and triggering rate limits.

## 🐞 Troubleshooting

- **"Unable to add remote origin"**: Ignore if the repo was created; just run `git remote set-url origin https://github.com/CrowSan/local-translator.git` followed by `git push -u origin master`.
- **Chrome does not open**: Ensure the path `C:\Program Files\Google\Chrome\Application\chrome.exe` exists. If not, update the `CHROME_PATH` variable in `translate.js`.
- **AI doesn't respond**: Check your internet connection and ensure you are logged into the AI service (Gemini/DeepSeek) in the Chrome profile that opens.
- **Missing `prompts/` folder**: The script will automatically create a `default.txt` prompt file on the first run if the folder is empty.

## 📝 License

This project is for **personal and educational use only**. Use responsibly.

---

**Happy Translating!** 🎉
```

### How to add this to your project:
1.  Copy the markdown above.
2.  Save it as `README.md` in `D:\Apps\node\local-translator\`.
3.  Add and commit it:
    ```bash
    git add README.md
    git commit -m "Add comprehensive README"
    git push origin master
    ```