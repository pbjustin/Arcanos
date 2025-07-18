import { Request, Response } from 'express';

export const askHandler = async (req: Request, res: Response) => {
  try {
    const { message, domain = "general", useRAG = true, useHRC = true } = req.body;

    // Placeholder logic — replace with real RAG/HRC pipeline
    console.log("Received:", { message, domain, useRAG, useHRC });

    // Mock response
    return res.status(200).json({ response: `ARCANOS received: ${message}` });
  } catch (error) {
    console.error("askHandler error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};