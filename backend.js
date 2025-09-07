
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { OpenAI } = require('openai');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const sessions = new Map(); // In-memory session storage

// Session cleanup every 30 minutes
setInterval(() => {
    const now = Date.now();
    sessions.forEach((session, sessionId) => {
        if (now - session.lastActivity > 30 * 60 * 1000) {
            sessions.delete(sessionId);
            console.log(`Session ${sessionId} cleaned up.`);
        }
    });
}, 30 * 60 * 1000);

app.use(cors());
app.use(express.json());
app.use(helmet()); // Add helmet for security

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // 100 requests per 15 minutes per IP
    message: 'Too many requests from this IP, please try again after 15 minutes',
});
app.use(limiter); // Apply rate limiting to all requests

app.get('/', (req, res) => {
    res.send('Proxessa Backend Running!');
});

app.post('/api/start-assessment', (req, res) => {
    console.log('Received /api/start-assessment request');
    const sessionId = uuidv4();
    const firstQuestion = {
        question: "What best describes your business?",
        options: [
            "A. Retail and E-commerce",
            "B. Service-based Business (consulting, agency, etc.)",
            "C. Manufacturing and Production",
            "D. Technology and Software Development"
        ],
        questionNumber: 1,
        isComplete: false,
    };

    sessions.set(sessionId, {
        businessType: null, // Will be stored after the first question is answered
        answers: [],
        lastActivity: Date.now(),
    });

    res.json({ success: true, data: { sessionId, ...firstQuestion } });
    console.log(`Session ${sessionId} started.`);
});

app.post('/api/next-question', async (req, res) => {
    console.log('Received /api/next-question request');
    const { sessionId, selectedAnswer, questionNumber } = req.body;

    if (!sessionId || !selectedAnswer || !questionNumber) {
        return res.status(400).json({ success: false, error: 'Missing sessionId, selectedAnswer, or questionNumber' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ success: false, error: 'Session not found or expired' });
    }

    session.lastActivity = Date.now();

    // Store business type if it's the first question
    if (questionNumber === 1) {
        session.businessType = selectedAnswer;
    }
    session.answers.push(`Question ${questionNumber}: ${selectedAnswer}`);

    try {
        const prompt = `Business type: ${session.businessType}, Previous answers: ${session.answers.join('; ')}. Generate next revealing question about their operations with 4 options A-D from organized to chaotic.`;
        console.log('OpenAI Question Prompt:', prompt);

        const openaiResponse = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{
                role: "user",
                content: prompt
            }],
            max_tokens: 200,
        });

        const aiContent = openaiResponse.choices[0].message.content.trim();
        console.log('OpenAI Response:', aiContent);

        // Basic parsing for question and options (can be improved for robustness)
        const lines = aiContent.split('\n').filter(line => line.trim() !== '');
        const question = lines[0] || "";
        const options = lines.slice(1, 5).filter(line => /[A-D]\. .*/.test(line));

        const isComplete = (questionNumber >= 5); // Example: Consider complete after 5 questions

        res.json({
            success: true,
            data: {
                question,
                options,
                questionNumber: questionNumber + 1,
                isComplete,
            },
        });
    } catch (error) {
        console.error('OpenAI API Error:', error);
        res.status(500).json({ success: false, error: 'Failed to generate next question' });
    }
});

// Add this route so you can test in browser
app.get('/api/start-assessment', (req, res) => {
  res.json({
    message: "✅ Backend is working! Use POST request for actual assessment.",
    howToTest: "Use Postman or the test HTML page",
    serverStatus: "Running on port 3000"
  });
});

// Add a simple health check too
app.get('/health', (req, res) => {
  res.json({
    status: "✅ Server is running perfectly",
    timestamp: new Date().toISOString()
  });
});

app.post('/api/generate-report', async (req, res) => {
    console.log('Received /api/generate-report request');
    const { sessionId } = req.body;

    if (!sessionId) {
        return res.status(400).json({ success: false, error: 'Missing sessionId' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ success: false, error: 'Session not found or expired' });
    }

    session.lastActivity = Date.now();

    try {
        const prompt = `Analyze responses: ${session.answers.join('; ')}. Create chaos score 1-100 and identify top 3 operational issues and provide actionable recommendations for each.`;
        console.log('OpenAI Report Prompt:', prompt);

        const openaiResponse = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{
                role: "user",
                content: prompt
            }],
            max_tokens: 500,
        });

        const aiContent = openaiResponse.choices[0].message.content.trim();
        console.log('OpenAI Report Response:', aiContent);

        // Basic parsing for report (can be improved for robustness)
        let score = 0;
        let topIssues = [];
        let recommendations = [];

        const scoreMatch = aiContent.match(/Chaos score: (\d+)/i);
        if (scoreMatch) {
            score = parseInt(scoreMatch[1], 10);
        }

        const issuesMatch = aiContent.match(/Top \d+ operational issues:\n([\s\S]*?)(?:\nRecommendation|$)/i);
        if (issuesMatch) {
            topIssues = issuesMatch[1].split('\n').filter(line => line.trim() !== '').map(line => line.trim());
        }

        const recommendationsMatch = aiContent.match(/Recommendations:\n([\s\S]*)/i);
        if (recommendationsMatch) {
            recommendations = recommendationsMatch[1].split('\n').filter(line => line.trim() !== '').map(line => line.trim());
        }

        res.json({
            success: true,
            data: {
                score,
                topIssues,
                recommendations,
            },
        });

        // Clean up session after report generation
        sessions.delete(sessionId);
        console.log(`Session ${sessionId} closed after report generation.`);

    } catch (error) {
        console.error('OpenAI API Error:', error);
        res.status(500).json({ success: false, error: 'Failed to generate report' });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
