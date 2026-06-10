import nodemailer from 'nodemailer';
import { config } from './config.js';

export const mailEnabled = () =>
  !!(config.smtp?.host && config.smtp?.user && config.smtp?.pass);

let transport = null;
function getTransport() {
  if (!transport) {
    const port = Number(config.smtp.port) || 587;
    transport = nodemailer.createTransport({
      host: config.smtp.host,
      port,
      secure: port === 465,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
      connectionTimeout: 15000,
      socketTimeout: 20000,
    });
  }
  return transport;
}

export async function sendCode(to, code, asn) {
  if (config.demo) {
    console.log(`[mailer] DEMO — would send code ${code} to ${to}`);
    return;
  }
  await getTransport().sendMail({
    from: config.smtp.from || config.smtp.user,
    to,
    subject: `[${config.networkName}] DN42 peering verification code: ${code}`,
    text: [
      'PEERING/DESK — verification code',
      '',
      `A login was requested for AS${asn} on the ${config.networkName} peering portal.`,
      '',
      `    ${code}`,
      '',
      'The code is valid for 15 minutes and can be used once.',
      'If you did not request this, you can safely ignore this mail.',
      '',
      `-- AS${config.ourAsn} peering desk`,
    ].join('\n'),
  });
}
