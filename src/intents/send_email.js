"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendEmailIntent = sendEmailIntent;
const sendEmail_1 = require("../utils/sendEmail");
async function sendEmailIntent(req, res) {
    const { to, subject, body } = req.body;
    if (!to || !subject || !body) {
        return res.status(400).json({ error: 'Missing required fields: to, subject, body.' });
    }
    const result = await (0, sendEmail_1.sendEmail)(to, subject, body);
    if (result.success) {
        return res.status(200).json({ message: 'Email sent successfully.', info: result.info });
    }
    else {
        return res.status(500).json({ error: result.error });
    }
}
