import nodemailer from 'nodemailer';

export async function sendEmail(to, subject, body) {
    const transporter = nodemailer.createTransporter({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
    });

    const mailOptions = {
        from: process.env.SMTP_USER,
        to,
        subject,
        text: body,
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        return { success: true, info };
    } catch (error) {
        return { success: false, error: error.message };
    }
}
