const fs = require('fs');

const files = [
  'index.html',
  'netlify/functions/lib/whatsappConversation.js'
];

const replacements = [
  [
    'Are you an employee, as opposed to an independent contractor?',
    'Hi, my name is Justine and I am a VRS Labour Law Assistant. I am here to help you work through what has happened. To start, are you employed by the company, rather than working for yourself as a freelancer or contractor?'
  ],
  [
    'Is your employer a South African registered entity, or operating in South Africa?',
    'Does your employer operate or do business in South Africa?'
  ],
  [
    'Are you employed in the public service under the Public Service Act, or by a government agency such as DOL, DPW, DOH, SAPS, or by the SANDF?',
    'Do you work for a government department or state entity, for example the Department of Labour, Health, Public Works, SAPS or the SANDF?'
  ],
  [
    'Are you employed in the public service under the Public Service Act, or by a government agency such as DOL, DPW, DOH, SAPS, or the SANDF?',
    'Do you work for a government department or state entity, for example the Department of Labour, Health, Public Works, SAPS or the SANDF?'
  ],
  [
    'Briefly tell me about the work issue you need help with. There is no right or wrong way to describe it. In your own words, what happened?',
    'Please tell me what has happened at work and what you would like help with. There is no right or wrong way to explain it. Just tell me in your own words.'
  ],
  [
    'Hi there. I am Justine, a Labour Law Assistant. Briefly tell me about the work issue you need help with so I can guide you. There is no right or wrong way to describe it. In your own words, what has happened?',
    'Thanks. Now please tell me what has happened at work and what you would like help with. There is no right or wrong way to explain it. Just tell me in your own words.'
  ],
  [
    'Did your employer clearly communicate the performance standards expected of you?',
    'Before this happened, had your employer clearly explained what was expected of you in your role?'
  ],
  [
    'Were you placed on a Performance Improvement Plan or given a formal opportunity to improve?',
    'Were you given a proper chance to improve, for example a formal Performance Improvement Plan, before anything happened?'
  ],
  [
    'Were the targets within your control, or did external factors affect them?',
    'Do you feel the targets were realistic and achievable, or were there things outside your control making them harder to reach, like equipment issues, understaffing or workload?'
  ],
  [
    'Were the performance targets within your control, or did external factors (broken equipment, support team failures, market conditions) affect them?',
    'Do you feel the targets were realistic and achievable, or were there things outside your control making them harder to reach, like equipment issues, understaffing or workload?'
  ],
  [
    "Please provide an email address or phone number for the company's HR department or your manager.",
    "Could you share a contact email or number for your employer's HR department or your manager? This just helps us know where to send correspondence."
  ],
  [
    'Please provide an email address or phone number for the company HR department or your manager. Type UNKNOWN if you do not have it.',
    "Could you share a contact email or number for your employer's HR department or your manager? This just helps us know where to send correspondence. Type UNKNOWN if you do not have it."
  ],
  [
    'And finally, what WhatsApp cell phone number should VRS use to contact you? Please include the country code, for example +27 82 123 4567.',
    'And finally, what WhatsApp cell phone number should VRS use to contact you? Please include the country code, for example +27 82 123 4567.'
  ],
  [
    'What is the exact name of the company you work(ed) for?',
    'What is the name of the company you work for, or worked for?'
  ],
  [
    'What is the exact name of the company you work or worked for?',
    'What is the name of the company you work for, or worked for?'
  ],
  [
    'Do you admit or dispute the conduct alleged?',
    'Do you agree with what your employer says happened, or do you dispute it?'
  ],
  [
    'What was the stated misconduct allegation?',
    'What did your employer say you had done wrong?'
  ],
  [
    'Did your employer hold a formal disciplinary hearing before dismissing you?',
    'Did your employer hold a disciplinary hearing before dismissing you?'
  ],
  [
    'Were you given written notice of the hearing and charges at least 48 hours beforehand?',
    'Before the hearing, were you given written notice and told what the charges were at least 48 hours beforehand?'
  ],
  [
    'Were you allowed a colleague or trade-union representative at the hearing?',
    'Were you allowed to have a colleague or trade union representative with you at the hearing?'
  ],
  [
    'Was the chairperson independent of the dispute?',
    'Was the person chairing the hearing independent, rather than someone directly involved in the issue?'
  ],
  [
    'Had you received prior written warnings for the same or similar conduct?',
    'Before this happened, had you received any written warnings for the same or a similar issue?'
  ],
  [
    'Did the employer provide training, instruction or guidance to help you improve?',
    'Did your employer give you training, guidance or support to help you improve?'
  ],
  [
    'Were others on your team meeting the standards you were measured against?',
    'Were other people on your team meeting the same targets or standards you were measured against?'
  ],
  [
    'Had you received prior performance warnings?',
    'Before this happened, had you received any warnings about your performance?'
  ],
  [
    'Describe the performance issues raised and what happened.',
    'In your own words, tell me what concerns were raised about your performance and what happened next.'
  ]
];

let total = 0;
for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  let count = 0;
  for (const [from, to] of replacements) {
    if (!from || from === to) continue;
    if (content.includes(from)) {
      const before = content;
      content = content.split(from).join(to);
      if (content !== before) count += 1;
    }
  }

  // Remove the remaining client-facing attorney wording from the WhatsApp intro.
  if (file.endsWith('whatsappConversation.js')) {
    const oldIntro = 'My automated assessment is not a substitute for advice from a qualified attorney. Type HELP at any time for human assistance, or RESTART to begin again.';
    const newIntro = 'My automated assessment helps VRS understand your situation, but a VRS consultant will make any final decision about your matter. Type HELP at any time for assistance, or RESTART to begin again.';
    if (content.includes(oldIntro)) {
      content = content.split(oldIntro).join(newIntro);
      count += 1;
    }
  }

  if (count === 0) throw new Error(`No expected copy replacements were found in ${file}`);
  fs.writeFileSync(file, content);
  console.log(`${file}: applied ${count} copy updates`);
  total += count;
}

if (total < 12) throw new Error(`Only ${total} copy replacements were applied; expected a broader wording pass`);
console.log(`Applied ${total} client-facing copy updates in total.`);
