"use client";
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { getCurrentUserPermissions, hasPermission, Permission } from '@/lib/permissions';
import AccessDenied from '@/components/admin/AccessDenied';
import { PlugZap, RefreshCw, AlertTriangle, CheckCircle2, Radar, FileJson } from 'lucide-react';

type TestResult = {
  ok?: boolean;
  message?: string;
  invoiceCount?: number;
  sampleInvoice?: {
    id: string;
    invoiceNumber?: string | null;
    invoiceDate?: string | null;
    customerName?: string | null;
    status?: string | null;
    lineCount: number;
    sampleLine?: {
      itemCode?: string | null;
      itemName?: string | null;
      description?: string | null;
      quantity: number;
    } | null;
  } | null;
  target?: {
    origin: string;
    pathname: string;
  };
  results?: Array<{
    mode: string;
    ok: boolean;
    status: number | null;
    statusText: string;
    bodyPreview: string;
  }>;
  firstInvoiceShape?: unknown;
  error?: string;
};

type ManagerEndpoint =
  | '/api/manager/test-connection'
  | '/api/manager/auth-probe'
  | '/api/manager/invoice-shape';

export default function StockDashboardPage() {
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [probing, setProbing] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const canView = hasPermission(permissions, 'stock.view');
  const canTestManager = hasPermission(permissions, 'integrations.manager.view');
  const busy = testing || probing || inspecting;

  useEffect(() => {
    async function initialise() {
      const userPermissions = await getCurrentUserPermissions();
      setPermissions(userPermissions);
      setLoading(false);
    }

    initialise();
  }, []);

  async function callManagerEndpoint(endpoint: ManagerEndpoint) {
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;

    if (!accessToken) {
      return { ok: false, error: 'You are not logged in.' };
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    return response.json();
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);

    try {
      const payload = await callManagerEndpoint('/api/manager/test-connection');
      setTestResult(payload);
    } catch (error) {
      setTestResult({
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown connection test error',
      });
    } finally {
      setTesting(false);
    }
  }

  async function runAuthProbe() {
    setProbing(true);
    setTestResult(null);

    try {
      const payload = await callManagerEndpoint('/api/manager/auth-probe');
      setTestResult(payload);
    } catch (error) {
      setTestResult({
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown auth probe error',
      });
    } finally {
      setProbing(false);
    }
  }

  async function inspectInvoiceShape() {
    setInspecting(true);
    setTestResult(null);

    try {
      const payload = await callManagerEndpoint('/api/manager/invoice-shape');
      setTestResult(payload);
    } catch (error) {
      setTestResult({
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown invoice shape inspection error',
      });
    } finally {
      setInspecting(false);
    }
  }

  if (loading) {
    return <div className="min-h-screen bg-[#050505] flex items-center justify-center text-zinc-500 font-mono text-xs uppercase tracking-widest">Loading stock dashboard...</div>;
  }

  if (!canView) {
    return <AccessDenied message="This page requires the stock.view permission." />;
  }

  return (
    <main className="p-12 max-w-6xl mx-auto text-zinc-300">
      <header className="mb-12 border-b border-zinc-800 pb-8">
        <h1 className="text-5xl font-bold uppercase tracking-tighter text-white">Stock & Manager.io</h1>
        <p className="text-zinc-500 font-mono text-[10px] uppercase tracking-widest mt-2">
          Component stock control and invoice sync testing
        </p>
      </header>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="border border-zinc-900 bg-[#0c0c0c] p-8">
          <div className="flex items-center gap-3 text-white mb-4">
            <PlugZap size={22} />
            <h2 className="text-xl font-bold uppercase tracking-tight">Manager.io Connection</h2>
          </div>

          <p className="text-zinc-500 text-sm leading-relaxed mb-8">
            The standard test calls the Manager.io sales invoices endpoint using the configured auth mode. The auth probe tries several safe authentication formats. The invoice shape inspection helps us find where Manager stores invoice line items.
          </p>

          <div className="flex flex-col sm:flex-row sm:flex-wrap gap-3">
            <button
              onClick={testConnection}
              disabled={busy || !canTestManager}
              className="bg-white text-black px-6 py-4 text-[10px] font-bold uppercase tracking-widest hover:bg-zinc-200 transition-all disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-3"
            >
              {testing ? <RefreshCw size={14} className="animate-spin" /> : <PlugZap size={14} />}
              {testing ? 'Testing...' : 'Test Connection'}
            </button>

            <button
              onClick={runAuthProbe}
              disabled={busy || !canTestManager}
              className="border border-zinc-700 text-white px-6 py-4 text-[10px] font-bold uppercase tracking-widest hover:bg-zinc-900 transition-all disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-3"
            >
              {probing ? <RefreshCw size={14} className="animate-spin" /> : <Radar size={14} />}
              {probing ? 'Probing...' : 'Run Auth Probe'}
            </button>

            <button
              onClick={inspectInvoiceShape}
              disabled={busy || !canTestManager}
              className="border border-zinc-700 text-white px-6 py-4 text-[10px] font-bold uppercase tracking-widest hover:bg-zinc-900 transition-all disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-3"
            >
              {inspecting ? <RefreshCw size={14} className="animate-spin" /> : <FileJson size={14} />}
              {inspecting ? 'Inspecting...' : 'Inspect Invoice Shape'}
            </button>
          </div>

          {!canTestManager && (
            <p className="mt-4 text-red-500 text-[10px] uppercase tracking-widest font-mono">
              Missing integrations.manager.view permission.
            </p>
          )}
        </div>

        <div className="border border-zinc-900 bg-black p-8 min-h-[260px]">
          <h2 className="text-xl font-bold uppercase tracking-tight text-white mb-6">Test Result</h2>

          {!testResult && (
            <p className="text-zinc-600 font-mono text-xs uppercase tracking-widest">No test run yet.</p>
          )}

          {testResult?.firstInvoiceShape && (
            <div className="space-y-5">
              <div className="flex items-center gap-3 text-emerald-500">
                <CheckCircle2 size={18} />
                <span className="text-[10px] uppercase tracking-widest font-bold">Invoice shape loaded</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs font-mono">
                <div className="p-4 border border-zinc-900 bg-[#0c0c0c]">
                  <span className="block text-zinc-600 uppercase mb-2">Invoices Found</span>
                  <span className="text-white text-2xl font-bold">{testResult.invoiceCount ?? 0}</span>
                </div>
              </div>
              <pre className="whitespace-pre-wrap text-xs font-mono text-zinc-400 bg-[#0c0c0c] border border-zinc-900 p-4 overflow-auto max-h-[600px]">
                {JSON.stringify(testResult.firstInvoiceShape, null, 2)}
              </pre>
            </div>
          )}

          {!testResult?.firstInvoiceShape && testResult?.results && (
            <div className="space-y-5">
              <div className="text-[10px] uppercase tracking-widest font-bold text-zinc-400">
                Target: {testResult.target?.origin}{testResult.target?.pathname}
              </div>
              <div className="space-y-3">
                {testResult.results.map((result) => (
                  <div key={result.mode} className={`border p-4 ${result.ok ? 'border-emerald-800 bg-emerald-950/20' : 'border-zinc-900 bg-[#0c0c0c]'}`}>
                    <div className="flex justify-between gap-4 mb-2">
                      <span className={`text-[10px] uppercase tracking-widest font-bold ${result.ok ? 'text-emerald-400' : 'text-zinc-400'}`}>{result.mode}</span>
                      <span className="text-[10px] font-mono text-zinc-500">{result.status ?? 'N/A'} {result.statusText}</span>
                    </div>
                    <pre className="whitespace-pre-wrap text-xs font-mono text-zinc-500 max-h-32 overflow-auto">{result.bodyPreview || 'No body returned'}</pre>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!testResult?.firstInvoiceShape && !testResult?.results && testResult?.ok && (
            <div className="space-y-5">
              <div className="flex items-center gap-3 text-emerald-500">
                <CheckCircle2 size={18} />
                <span className="text-[10px] uppercase tracking-widest font-bold">Connection succeeded</span>
              </div>
              <div className="grid grid-cols-2 gap-4 text-xs font-mono">
                <div className="p-4 border border-zinc-900 bg-[#0c0c0c]">
                  <span className="block text-zinc-600 uppercase mb-2">Invoices Found</span>
                  <span className="text-white text-2xl font-bold">{testResult.invoiceCount ?? 0}</span>
                </div>
                <div className="p-4 border border-zinc-900 bg-[#0c0c0c]">
                  <span className="block text-zinc-600 uppercase mb-2">Sample Lines</span>
                  <span className="text-white text-2xl font-bold">{testResult.sampleInvoice?.lineCount ?? 0}</span>
                </div>
              </div>

              {testResult.sampleInvoice && (
                <div className="p-4 border border-zinc-900 bg-[#0c0c0c] text-xs font-mono text-zinc-400 space-y-2">
                  <p><span className="text-zinc-600 uppercase">Invoice:</span> {testResult.sampleInvoice.invoiceNumber || testResult.sampleInvoice.id}</p>
                  <p><span className="text-zinc-600 uppercase">Date:</span> {testResult.sampleInvoice.invoiceDate || 'N/A'}</p>
                  <p><span className="text-zinc-600 uppercase">Customer:</span> {testResult.sampleInvoice.customerName || 'N/A'}</p>
                  <p><span className="text-zinc-600 uppercase">Sample Line SKU:</span> {testResult.sampleInvoice.sampleLine?.itemCode || 'N/A'}</p>
                  <p><span className="text-zinc-600 uppercase">Sample Line:</span> {testResult.sampleInvoice.sampleLine?.itemName || testResult.sampleInvoice.sampleLine?.description || 'N/A'}</p>
                  <p><span className="text-zinc-600 uppercase">Qty:</span> {testResult.sampleInvoice.sampleLine?.quantity ?? 'N/A'}</p>
                </div>
              )}
            </div>
          )}

          {testResult && !testResult.ok && !testResult.results && !testResult.firstInvoiceShape && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 text-red-500">
                <AlertTriangle size={18} />
                <span className="text-[10px] uppercase tracking-widest font-bold">Connection failed</span>
              </div>
              <pre className="whitespace-pre-wrap text-xs font-mono text-red-300 bg-red-950/20 border border-red-950 p-4">
                {testResult.error || 'Unknown error'}
              </pre>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
