// Mistral

import { Mistral } from '@mistralai/mistralai';
import fs from 'fs';

async function encodePdf(pdfPath) {
    try {
        // Read the PDF file as a buffer
        const pdfBuffer = fs.readFileSync(pdfPath);

        // Convert the buffer to a Base64-encoded string
        const base64Pdf = pdfBuffer.toString('base64');
        return base64Pdf;
    } catch (error) {
        console.error(`Error: ${error}`);
        return null;
    }
}

const pdfPath = "path_to_your_pdf.pdf";

const base64Pdf = await encodePdf(pdfPath);

const apiKey = process.env.MISTRAL_API_KEY;
const client = new Mistral({ apiKey: apiKey });

try {
    const ocrResponse = await client.ocr.process({
        model: "mistral-ocr-latest",
        document: {
            type: "document_url",
            documentUrl: "data:application/pdf;base64," + base64Pdf
        },
        includeImageBase64: true
    });
    console.log(ocrResponse);
} catch (error) {
    console.error("Error processing OCR:", error);
}

// Nanonets via ollama or lmstudio


const OCR_ENDPOINT = await env(
  "LMSTUDIO_ENDPOINT",
  "http://localhost:11434/v1/chat/completions",
);
const API_KEY = await env("OLLAMA_API_KEY", "sk-1234");

try {
  setStatus({ message: "Processing image...", status: "busy" });

  const response = await post(
    OCR_ENDPOINT,
    {
      model: "Nanonets-OCR-s", // or whatever model supports vision
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "",
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${base64Image}`,
              },
            },
          ],
        },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
    },
  );
  setStatus({ message: "Done processing image", status: "success" });
  const extractedText = response.data.choices[0].message.content.trim();
