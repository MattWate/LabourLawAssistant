const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    // --- SECURITY CHECK ---
    const authHeader = event.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    try {
        // Build the Skeleton "Blank" Facts
        const blankFacts = {
            client_name: "New Manual Client",
            contact_info: "",
            employer_name: "",
            employer_contact_details: "",
            incident_date: "",
            incident_description: "",
            hearing_held: null,
            wants_letter: true, // Forces the 'Generate Draft' button to appear in the UI
            employment_status: "",
            paid_suspension: null,
            constructive_dismissal: null,
            contract_type: "",
            sector: "",
            merit_assessment: "Manual Override",
            legal_reasoning: "Matter created manually by Attorney. No preliminary AI assessment performed."
        };

        const dbPayload = {
            client_name: "New Manual Client",
            issue_summary: "Manual entry pending...",
            case_facts: blankFacts,
            status: 'requires_attorney',
            letter_status: null
        };

        const { data, error } = await supabase.from('cases').insert(dbPayload).select().single();
        
        if (error) throw error;

        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ success: true, case: data })
        };
    } catch (error) {
        console.error("Creation Error:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
```

### 2. Update the Admin Header (`admin.html`)
In your `admin.html` file, find the `.header` section (around line 105). We are going to add a new green button next to the Settings button.

Replace the header block with this:

```html
        <div class="header">
            <div>
                <h1>Case Book Review</h1>
                <p>Matter Management</p>
            </div>
            <div style="display: flex; gap: 10px; align-items: center;">
                <button class="btn btn-success" style="padding: 6px 12px; font-size: 0.8rem;" onclick="createNewMatter()">➕ New Matter</button>
                
                <button class="btn btn-primary" style="padding: 6px 12px; font-size: 0.8rem; background: #334155;" onclick="openSettingsModal()">⚙️ Settings</button>
                <button class="btn btn-logout" onclick="handleLogout()">Logout</button>
            </div>
        </div>
```

### 3. Add the Javascript Function (`admin.html`)
Scroll down to the bottom of your `<script>` block in `admin.html` (right before `checkAuth();` runs at the very end), and paste this function. It calls our new backend endpoint and refreshes the case list so the new blank case pops up at the top immediately.

```javascript
    // --- MANUAL CASE CREATION LOGIC ---
    async function createNewMatter() {
        if (!confirm("Create a new blank matter?")) return;
        
        // Change button text temporarily
        const btn = document.querySelector('.btn-success');
        const originalText = btn.innerText;
        btn.innerText = "⏳ Creating...";
        btn.disabled = true;

        try {
            const res = await fetch('/.netlify/functions/create_case', { 
                method: 'POST', 
                headers: getAuthHeaders() 
            });
            
            if (res.ok) { 
                await fetchCases(); // Refresh the list to show the new case at the top
            } else { 
                alert("Failed to create new matter. Please check your connection."); 
            }
        } catch (e) { 
            alert("Error: " + e.message); 
        } finally {
            btn.innerText = originalText;
            btn.disabled = false;
        }
    }
