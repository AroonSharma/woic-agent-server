// @ts-nocheck
import pdf from 'pdf-parse';
import mammoth from 'mammoth';
import * as xlsx from 'xlsx';
import { createWorker } from 'tesseract.js';
import sharp from 'sharp';

export interface DocumentMetadata {
  title?: string;
  author?: string;
  pageCount?: number;
  wordCount?: number;
  createdAt?: Date;
  modifiedAt?: Date;
}

export interface ParseResult {
  text: string;
  metadata: DocumentMetadata;
  sourceType: string;
}

export interface ParseOptions {
  enableOCR?: boolean;
  ocrLanguage?: string;
  maxFileSize?: number; // bytes
  timeout?: number; // ms
}

// Security: Define allowed MIME types to prevent malicious uploads
const ALLOWED_MIME_TYPES = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/jpg': 'image',
  'image/tiff': 'image',
  'image/bmp': 'image'
} as const;

const DEFAULT_OPTIONS: ParseOptions = {
  enableOCR: false,
  ocrLanguage: 'eng',
  maxFileSize: 50 * 1024 * 1024, // 50MB
  timeout: 30000 // 30 seconds
};

export function detectFileType(buffer: Buffer, mimeType: string): string | null {
  // Security: Validate MIME type against allowed list
  if (!Object.keys(ALLOWED_MIME_TYPES).includes(mimeType)) {
    return null;
  }

  // Additional magic number validation for security
  const magicNumbers = {
    pdf: Buffer.from([0x25, 0x50, 0x44, 0x46]), // %PDF
    zip: Buffer.from([0x50, 0x4B, 0x03, 0x04]), // PK (for docx/xlsx)
    jpeg: Buffer.from([0xFF, 0xD8, 0xFF]),
    png: Buffer.from([0x89, 0x50, 0x4E, 0x47]),
    bmp: Buffer.from([0x42, 0x4D]),
    tiff: Buffer.from([0x49, 0x49, 0x2A, 0x00])
  };

  const detectedType = ALLOWED_MIME_TYPES[mimeType as keyof typeof ALLOWED_MIME_TYPES];
  
  // Verify magic numbers for additional security
  if (detectedType === 'pdf' && buffer.subarray(0, 4).equals(magicNumbers.pdf)) {
    return 'pdf';
  }
  if ((detectedType === 'docx' || detectedType === 'xlsx') && buffer.subarray(0, 4).equals(magicNumbers.zip)) {
    return detectedType;
  }
  if (detectedType === 'image') {
    if (buffer.subarray(0, 3).equals(magicNumbers.jpeg)) return 'image';
    if (buffer.subarray(0, 4).equals(magicNumbers.png)) return 'image';
    if (buffer.subarray(0, 2).equals(magicNumbers.bmp.subarray(0, 2))) return 'image';
    if (buffer.subarray(0, 4).equals(magicNumbers.tiff)) return 'image';
  }

  return detectedType;
}

async function parsePDF(buffer: Buffer, options: ParseOptions): Promise<ParseResult> {
  try {
    const data = await pdf(buffer);
    
    return {
      text: data.text || '',
      metadata: {
        title: data.info?.Title || '',
        author: data.info?.Author || '',
        pageCount: data.numpages || 0,
        createdAt: data.info?.CreationDate || undefined,
        modifiedAt: data.info?.ModDate || undefined
      },
      sourceType: 'pdf'
    };
  } catch (error) {
    throw new Error(`PDF parsing failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function parseWord(buffer: Buffer, options: ParseOptions): Promise<ParseResult> {
  try {
    const result = await mammoth.extractRawText({ buffer });
    
    // Word count estimation
    const wordCount = result.value.split(/\s+/).filter(word => word.length > 0).length;
    
    return {
      text: result.value || '',
      metadata: {
        wordCount,
        // Note: mammoth doesn't extract document properties by default
        // Could be enhanced with additional libraries for full metadata
      },
      sourceType: 'docx'
    };
  } catch (error) {
    throw new Error(`Word document parsing failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function parseExcel(buffer: Buffer, options: ParseOptions): Promise<ParseResult> {
  try {
    const workbook = xlsx.read(buffer, { type: 'buffer' });
    let allText = '';
    let sheetCount = 0;
    
    // Process all worksheets
    for (const sheetName of workbook.SheetNames) {
      const worksheet = workbook.Sheets[sheetName];
      const jsonData = xlsx.utils.sheet_to_json(worksheet, { header: 1 });
      
      // Convert sheet data to text with structure preservation
      allText += `\n=== Sheet: ${sheetName} ===\n`;
      
      for (const row of jsonData as any[][]) {
        if (row && row.length > 0) {
          const rowText = row.map(cell => cell?.toString() || '').join(' | ');
          if (rowText.trim()) {
            allText += rowText + '\n';
          }
        }
      }
      sheetCount++;
    }
    
    return {
      text: allText.trim(),
      metadata: {
        title: workbook.Props?.Title || '',
        author: workbook.Props?.Author || '',
        pageCount: sheetCount,
        createdAt: workbook.Props?.CreatedDate || undefined,
        modifiedAt: workbook.Props?.ModifiedDate || undefined
      },
      sourceType: 'xlsx'
    };
  } catch (error) {
    throw new Error(`Excel parsing failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function parseImage(buffer: Buffer, options: ParseOptions): Promise<ParseResult> {
  if (!options.enableOCR) {
    throw new Error('OCR not enabled for image processing');
  }

  let worker: any = null;
  try {
    // Preprocess image with sharp for better OCR results
    const processedBuffer = await sharp(buffer)
      .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
      .normalize()
      .sharpen()
      .png()
      .toBuffer();

    // Initialize Tesseract worker
    worker = await createWorker();
    await worker.loadLanguage(options.ocrLanguage || 'eng');
    await worker.initialize(options.ocrLanguage || 'eng');
    
    // Perform OCR with timeout protection
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('OCR timeout')), options.timeout || 30000)
    );
    
    const ocrPromise = worker.recognize(processedBuffer);
    const { data } = await Promise.race([ocrPromise, timeoutPromise]) as any;
    
    return {
      text: data.text || '',
      metadata: {
        wordCount: data.text ? data.text.split(/\s+/).length : 0
      },
      sourceType: 'image-ocr'
    };
  } catch (error) {
    throw new Error(`Image OCR failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (worker) {
      try {
        await worker.terminate();
      } catch (e) {
        // Cleanup error - log but don't throw
        console.warn('Failed to terminate OCR worker:', e);
      }
    }
  }
}

export async function parseDocument(
  buffer: Buffer,
  mimeType: string,
  options: Partial<ParseOptions> = {}
): Promise<ParseResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  
  // Security: Validate file size
  if (buffer.length > opts.maxFileSize!) {
    throw new Error(`File size ${buffer.length} exceeds maximum allowed size ${opts.maxFileSize}`);
  }
  
  // Security: Detect and validate file type
  const fileType = detectFileType(buffer, mimeType);
  if (!fileType) {
    throw new Error(`Unsupported or invalid file type: ${mimeType}`);
  }

  // Set up timeout for all parsing operations
  const timeoutPromise = new Promise<never>((_, reject) => 
    setTimeout(() => reject(new Error('Document parsing timeout')), opts.timeout!)
  );

  try {
    let parsePromise: Promise<ParseResult>;
    
    switch (fileType) {
      case 'pdf':
        parsePromise = parsePDF(buffer, opts);
        break;
      case 'docx':
      case 'doc':
        parsePromise = parseWord(buffer, opts);
        break;
      case 'xlsx':
      case 'xls':
        parsePromise = parseExcel(buffer, opts);
        break;
      case 'image':
        parsePromise = parseImage(buffer, opts);
        break;
      default:
        throw new Error(`Unsupported file type: ${fileType}`);
    }

    const result = await Promise.race([parsePromise, timeoutPromise]);
    
    // Post-processing: Validate result
    if (!result.text || result.text.trim().length < 10) {
      throw new Error('Document parsing resulted in insufficient text content');
    }

    return result;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Document parsing failed: ${String(error)}`);
  }
}

// Utility function to estimate processing time based on file size and type
export function estimateProcessingTime(fileSize: number, fileType: string): number {
  const baseTime = 5000; // 5 seconds base
  const sizeMultiplier = Math.ceil(fileSize / (1024 * 1024)); // Per MB
  
  const typeMultipliers = {
    pdf: 1.5,
    docx: 1.2,
    xlsx: 2.0,
    image: 5.0 // OCR is slow
  };
  
  const multiplier = typeMultipliers[fileType as keyof typeof typeMultipliers] || 1;
  return baseTime + (sizeMultiplier * 2000 * multiplier);
}