# English-Amoy Dictionary Digitization Plan

## Overview
The English-Amoy Dictionary (634 pages) by Rev. J. Macgowan is a historical dictionary of the Amoy (Hokkien/Xiamen) dialect. This plan outlines the steps to digitize it into a functional web/mobile application.

## 1. Assessment & Data Extraction

### Current State
- **Source**: `English-Amoy-Dictionary.pdf` (634 pages) by Rev. J. Macgowan (1883)
- **Format**: Scanned/historical PDF with English entries, Amoy romanization, and Chinese characters (Amoy/Hokkien)
- **Extracted text**: Available via `pdftotext` but Chinese characters may not be properly extracted as Unicode text layer
- **Available from**: [Internet Archive](https://archive.org/details/cu31924023550878)

### Extraction Strategy
- [ ] **Check for existing OCR** - Look for DjVu XML or text OCR files on Internet Archive first (may be drafts)
- [ ] **Test text layer** - Verify if Chinese characters are extractable from the PDF text layer or if pages are scanned images
- [ ] **Preserve original layout** - Use tools like `pdftotext -layout`, `pdfplumber` (Python) to understand structure
- [ ] **Handle Chinese characters properly** - Chinese characters (Han) need special handling; the romanization alone is insufficient
- [ ] **OCR for Chinese text** - If text layer is missing/incomplete, use OCR tools optimized for Traditional Chinese historical text
- [ ] **Extract page by page** - Process systematically to maintain context between English entries and their Chinese equivalents
- [ ] **Manual spot checking** - Verify sample entries against original page images for accuracy

**Recommended tools:**
- `pdftotext` / `poppler-utils` - Quick text extraction test
- `pdfplumber` (Python) - Better at preserving structure and text positioning
- **OCR Options:**
  - [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) / [PaddleX](https://paddlepaddle.github.io/PaddleX/) - Best for Traditional Chinese printed text (PP-OCRv5 supports Traditional Chinese)
  - [Kraken](https://kraken.re/) - Best for historical/irregular fonts, trainable for this specific typeface
  - [Tesseract](https://tesseract-ocr.github.io/) - Fallback option with Chinese language packs
- `pdf2image` - Convert PDF pages to images for OCR

## 2. Data Structuring & Parsing

### Entry Format Analysis
From initial inspection:
```
Aback, |R]° ^° nig au,           M
```
English word, followed by Chinese characters/transliteration in Amoy dialect notation.

### Target Data Schema
```json
{
  "id": "uuid",
  "headword": "aback",
  "headword_normalized": "aback",
  "part_of_speech": "adv./v./n./adj.",
  "phonetic": "Amoy romanization (e.g., nig au)",
  "definitions": [
    {
      "id": "uuid",
      "definition_text": "English definition/context",
      "chinese_characters": ["汉字", "characters in traditional/simplified as they appear"],
      "amoy_romanization": ["peh-oe-ji or Macgowan's romanization"],
      "examples": [],
      "order_index": 0
    }
  ],
  "page_number": 123,
  "notes": "additional notes",
  "variants": ["alternative forms"],
  "cross_references": ["see also..."]
}
```

**Important Notes:**
- Store actual Chinese characters (Unicode Han script), not just romanization
- Preserve the original Amoy romanization system used by Macgowan (may differ from modern Pe̍h-ōe-jī)
- Keep Chinese and romanization as separate fields - OCR tools identify characters, not necessarily the pronunciation mapping

### Parsing Tasks
- [ ] **Identify entry boundaries** - Dictionary entries typically start with a headword (English words)
- [ ] **Separate components** - Extract headword, part of speech, Amoy romanization, Chinese characters, definitions
- [ ] **OCR validation** - If using OCR, verify Chinese character accuracy against source images
- [ ] **Preserve original characters** - Don't normalize to simplified/traditional unless necessary; keep as in original
- [ ] **Parse cross-references** - Handle "see also", abbreviations
- [ ] **Normalize romanization** - The text uses Macgowan's specific Amoy romanization system
- [ ] **Clean formatting artifacts** - Remove page numbers, headers, footers, stray symbols
- [ ] **Handle multi-line entries** - Some definitions span multiple lines
- [ ] **Link Chinese to entries** - Ensure Chinese characters are correctly associated with their definitions

## 3. Database Design

### Recommended Database
- **PostgreSQL** - Robust full-text search, good for multilingual content
- **SQLite** - Simpler for smaller deployments/mobile
- **Elasticsearch/Meilisearch** - Excellent for dictionary search with fuzzy matching

### Schema
```sql
CREATE TABLE entries (
  id UUID PRIMARY KEY,
  headword VARCHAR(255) NOT NULL,
  headword_normalized VARCHAR(255) NOT NULL, -- lowercase, no punctuation
  part_of_speech VARCHAR(50),
  phonetic VARCHAR(255), -- Amoy romanization
  page_number INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE definitions (
  id UUID PRIMARY KEY,
  entry_id UUID REFERENCES entries(id),
  definition_text TEXT,
  chinese_characters TEXT, -- Unicode Han characters as they appear
  amoy_romanization TEXT,  -- romanization in Macgowan's system
  order_index INTEGER
);

CREATE INDEX idx_headword ON entries(headword_normalized);
CREATE INDEX idx_headword_trgm ON entries USING gin(headword_normalized gin_trgm_ops);
CREATE INDEX idx_chinese ON definitions USING gin(to_tsvector('simple', chinese_characters));
```

## 4. Application Architecture

### Option 1: Web App (Recommended for MVP)
**Tech Stack:**
- **Frontend**: Next.js 15 + TypeScript + Tailwind CSS
- **Backend**: Next.js API routes or separate Node.js/Express
- **Database**: PostgreSQL with Prisma ORM
- **Search**: PostgreSQL full-text search or Meilisearch
- **Hosting**: Vercel (frontend) + Railway/Render (backend/db)

### Option 2: Static Site
- Pre-generate all entries as JSON
- Use client-side search (Fuse.js)
- Host on GitHub Pages/Netlify
- Simpler, no backend needed
- Good for read-only dictionary

### Option 3: Mobile App
- React Native or Flutter
- Can use local SQLite database
- Good for offline access

**Recommendation**: Start with a static site for MVP (easier to deploy), can evolve to full-stack later.

## 5. Core Features

### Must Have
- [ ] **Browse by letter** - A-Z index navigation
- [ ] **Search functionality** - Search English words, Chinese terms, or romanization
- [ ] **Entry display** - Show headword, pronunciation, definitions, Chinese characters
- [ ] **Responsive design** - Works on mobile and desktop
- [ ] **Fast search** - Instant results as user types

### Nice to Have
- [ ] **Fuzzy search** - Handle typos and alternate spellings
- [ ] **Reverse search** - Search by Chinese characters or romanization
- [ ] **Favorites/bookmarks** - Save frequently looked up words
- [ ] **History** - Recent searches
- [ ] **Pronunciation audio** - If available historically or can be reconstructed
- [ ] **Dark mode**
- [ ] **Export/share** - Share entries
- [ ] **Related entries** - Cross-references

## 6. Implementation Plan

### Phase 1: Data Extraction (1-2 weeks)
1. Extract full text from PDF using `pdftotext -layout`
2. Split into pages/sections
3. Create a Python script to parse entries
4. Manually verify parsing on sample entries
5. Iterate on parser until accuracy is acceptable

### Phase 2: Data Cleaning & Structuring (1-2 weeks)
1. Clean up OCR artifacts and formatting issues
2. Normalize headwords and romanization
3. Structure into JSON/CSV
4. Build validation scripts
5. Create final dataset

### Phase 3: MVP Development (2-3 weeks)
1. Set up project structure
2. Create data loading mechanism
3. Build search and browse UI
4. Implement entry detail view
5. Add basic styling
6. Deploy to static hosting

### Phase 4: Enhancement & Polish (1-2 weeks)
1. Improve search with fuzzy matching
2. Add reverse search capabilities
3. Optimize performance
4. Add PWA support for offline use
5. User testing and bug fixes

## 7. Technical Considerations

### Challenges
- **Chinese character extraction** - Text layer may not contain Chinese characters properly; may need OCR for Han script
- **Character encoding** - Historical Chinese text may have complex/traditional characters, variants, or old forms
- **Romanization system** - Need to understand Macgowan's specific Amoy romanization (different from modern Pe̍h-ōe-jī)
- **Layout parsing** - Multi-column layouts, mixed scripts (Latin, Chinese), footnotes, abbreviations
- **OCR accuracy** - Historical typefaces, small characters, and old printing can challenge OCR models
- **Data quality** - Some entries may be misparsed or Chinese characters misrecognized
- **Scale** - 634 pages will yield thousands of entries

### Solutions
- **For Chinese**: Try existing Internet Archive OCR first, then benchmark PaddleOCR/Kraken/Tesseract on samples
- **For characters**: Use Unicode normalization carefully (preserve original forms); don't auto-convert traditional/simplified
- **For romanization**: Document Macgowan's system for users, keep as-is
- **For layout**: Use tools that preserve positioning (pdfplumber) to associate Chinese with correct entries
- **For quality**: Build validation against page images, implement manual review workflow
- **For scale**: Process in batches, use progressive loading/search for large datasets

## 8. Quick Start Commands

```bash
# Extract text with layout preservation
pdftotext -layout English-Amoy-Dictionary.pdf dict-layout.txt

# Try pdfplumber for better structure (Python)
pip install pdfplumber
python extract_dict.py

# Create a simple static site
npx create-next-app@latest amoy-dictionary
```

## 9. Deliverables

- [ ] Parsed dictionary dataset (JSON)
- [ ] Data extraction and cleaning scripts
- [ ] Web application
- [ ] Documentation (README, data format, romanization guide)
- [ ] Deployment

## Resources
- [Internet Archive copy](http://www.archive.org/details/cu31924023550878) - Original source
- [Amoy dialect (Xiamen Hokkien)](https://en.wikipedia.org/wiki/Xiamen_Hokkien) - Context
- [Hokkien romanization systems](https://en.wikipedia.org/wiki/Pe%CC%8Dh-%C5%8De-j%C4%AB) - Understanding romanization

---

**Note**: This is a historical dictionary - be mindful of copyright/status (stated as no known restrictions in US per metadata). Focus on accurate preservation and making this valuable linguistic resource accessible.