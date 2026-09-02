const fs = require('fs');

// Web: the first visible question is the jurisdiction gate, so it carries the short introduction.
{
  const file = 'index.html';
  let content = fs.readFileSync(file, 'utf8');
  const oldText = 'Hi, my name is Justine and I am a VRS Labour Law Assistant. I am here to help you work through what has happened. To start, are you employed by the company, rather than working for yourself as a freelancer or contractor?';
  const newText = 'Hi, my name is Justine and I am a VRS Labour Law Assistant. I am here to help you work through what has happened. Before we start, the information you share will be used by VRS Labour Law Consultants to understand and assess your matter and will be handled as part of your VRS enquiry. Justine provides an initial automated assessment, and a VRS consultant reviews the matter and decides the next step. The automated flow is currently in English. To start, are you employed by the company, rather than working for yourself as a freelancer or contractor?';
  if (!content.includes(oldText)) throw new Error('Expected web introduction was not found');
  content = content.replace(oldText, newText);
  fs.writeFileSync(file, content);
}

// WhatsApp: INTRO is sent before the first question, so keep the first question concise and put process/privacy in INTRO.
{
  const file = 'netlify/functions/lib/whatsappConversation.js';
  let content = fs.readFileSync(file, 'utf8');
  const oldIntro = `const INTRO = \`Hi, I am Justine, the VRS Labour Law Assistant. I will ask a series of questions to understand your situation and prepare it for review by the VRS legal team.\\n\\nMy automated assessment helps VRS understand your situation, but a VRS consultant will make any final decision about your matter. Type HELP at any time for assistance, or RESTART to begin again.\`;`;
  const newIntro = `const INTRO = \`Hi, I am Justine, the VRS Labour Law Assistant. I will ask a few questions to understand what has happened. The information you share will be used by VRS Labour Law Consultants to understand and assess your matter and will be handled as part of your VRS enquiry.\\n\\nJustine provides an initial automated assessment, and a VRS consultant reviews the matter and decides the next step. The automated flow is currently in English. Type HELP at any time for assistance, or RESTART to begin again.\`;`;
  if (!content.includes(oldIntro)) throw new Error('Expected WhatsApp INTRO was not found');
  content = content.replace(oldIntro, newIntro);

  const oldQuestion = "JUR_EMPLOYEE: buttons('Hi, my name is Justine and I am a VRS Labour Law Assistant. I am here to help you work through what has happened. To start, are you employed by the company, rather than working for yourself as a freelancer or contractor?'";
  const newQuestion = "JUR_EMPLOYEE: buttons('To start, are you employed by the company, rather than working for yourself as a freelancer or contractor?'";
  if (!content.includes(oldQuestion)) throw new Error('Expected WhatsApp first question was not found');
  content = content.replace(oldQuestion, newQuestion);
  fs.writeFileSync(file, content);
}

console.log('Applied intake privacy, process and language introduction to web and WhatsApp.');
