import { useEffect, useMemo, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";
import QRCode from "qrcode";
import { jsPDF } from "jspdf";
import { FUNCTIONS_URL, configured, supabase } from "./supabase";

type TicketEvent = { id: string; name: string; count: number; kind: "REAL" | "TEST" };
type AuthMode = "signin" | "signup";
type Result = "VERIFIED" | "INVALID" | "SERVICE_UNAVAILABLE" | null;

const STORE_KEY = "culture-day-events-v1";

async function downloadTicketsPdf(event: TicketEvent, tickets: {number:number;token:string}[]) {
  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const cols = 3, rows = 4, cellW = 63, cellH = 68, startX = 10, startY = 10;
  for (let i = 0; i < tickets.length; i++) {
    if (i > 0 && i % (cols * rows) === 0) pdf.addPage();
    const pos = i % (cols * rows);
    const x = startX + (pos % cols) * cellW;
    const y = startY + Math.floor(pos / cols) * cellH;
    pdf.setDrawColor(45, 48, 56);
    pdf.roundedRect(x, y, 58, 63, 3, 3);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(10);
    pdf.text("CULTURE DAY", x + 29, y + 8, { align: "center" });
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(8);
    pdf.text(`${event.kind} TICKET  •  #${String(tickets[i].number).padStart(3,"0")}`, x + 29, y + 14, { align: "center" });
    const qr = await QRCode.toDataURL(tickets[i].token, { errorCorrectionLevel: "H", margin: 1, width: 420 });
    pdf.addImage(qr, "PNG", x + 9, y + 17, 40, 40);
    pdf.setFontSize(6);
    pdf.text("One entry • One scan • Keep this QR private", x + 29, y + 60, { align: "center" });
  }
  pdf.save(`culture-day-${event.kind.toLowerCase()}-tickets.pdf`);
}

function explainError(message: string) {
  if (/invalid login credentials/i.test(message)) return "Email or password is incorrect.";
  if (/email not confirmed/i.test(message)) return "Confirm your email first, then sign in.";
  if (/user already registered/i.test(message)) return "This email already has an account. Sign in instead.";
  return message;
}

export default function App() {
  const [session, setSession] = useState<any>(null);
  const [authMode, setAuthMode] = useState<AuthMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<"tickets" | "scanner">("tickets");
  const [events, setEvents] = useState<TicketEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState("");
  const [scanResult, setScanResult] = useState<Result>(null);
  const [scanMessage, setScanMessage] = useState("");
  const [scanBusy, setScanBusy] = useState(false);
  const [manualToken, setManualToken] = useState("");
  const [cameraOn, setCameraOn] = useState(false);
  const [eventBusy, setEventBusy] = useState(false);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const handledRef = useRef(false);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({data}) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "[]") as TicketEvent[];
      setEvents(saved);
      if (saved.length) setSelectedEvent(saved[0].id);
    } catch { /* ignore malformed local cache */ }
  }, []);

  useEffect(() => {
    return () => {
      if (scannerRef.current?.isScanning) scannerRef.current.stop().catch(() => undefined);
    };
  }, []);

  const currentEvent = useMemo(() => events.find(e => e.id === selectedEvent), [events, selectedEvent]);

  async function authenticate() {
    if (!supabase) return;
    setAuthBusy(true); setNotice("");
    try {
      if (authMode === "signup") {
        const { data, error } = await supabase.auth.signUp({ email: email.trim(), password });
        if (error) throw error;
        if (!data.session) setNotice("Account created. Check your email to confirm it, then sign in.");
        else setNotice("Account created and signed in.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
      }
    } catch (e: any) { setNotice(explainError(e.message || "Authentication failed.")); }
    finally { setAuthBusy(false); }
  }

  async function signOut() {
    await supabase?.auth.signOut();
    setScanResult(null); setCameraOn(false);
  }

  async function createTicketSet(kind: "REAL" | "TEST", count: number) {
    if (!supabase || !session?.access_token) return;
    setEventBusy(true); setNotice("");
    try {
      const response = await fetch(`${FUNCTIONS_URL}/create-event-tickets`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
          "apikey": import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
        },
        body: JSON.stringify({ name: kind === "REAL" ? "Culture Day" : "Culture Day TEST", count })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Ticket creation failed (${response.status}).`);
      const event: TicketEvent = { id: payload.event_id, name: kind === "REAL" ? "Culture Day" : "Culture Day TEST", count: payload.count, kind };
      const next = [event, ...events];
      setEvents(next); setSelectedEvent(event.id);
      localStorage.setItem(STORE_KEY, JSON.stringify(next));
      await downloadTicketsPdf(event, payload.tickets);
      setNotice(`${count} ${kind.toLowerCase()} tickets registered. The PDF has been downloaded. Keep it private.`);
    } catch (e: any) {
      setNotice(e.message || "Could not create tickets. No tickets were confirmed.");
    } finally { setEventBusy(false); }
  }

  async function stopCamera() {
    if (scannerRef.current?.isScanning) {
      try { await scannerRef.current.stop(); } catch { /* camera may already be stopped */ }
    }
    scannerRef.current = null;
    setCameraOn(false);
  }

  async function verifyToken(raw: string) {
    const token = raw.trim();
    if (!token || !currentEvent || !supabase || !session?.access_token || scanBusy) return;
    setScanBusy(true); setScanResult(null); setScanMessage("");
    try {
      const response = await fetch(`${FUNCTIONS_URL}/verify-ticket`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
          "apikey": import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
        },
        body: JSON.stringify({ event_id: currentEvent.id, token })
      });
      if (!response.ok) {
        if (response.status === 503) {
          setScanResult("SERVICE_UNAVAILABLE");
          setScanMessage("Backend unavailable. Do not admit this ticket.");
        } else if (response.status === 401 || response.status === 403) {
          setScanResult("INVALID");
          setScanMessage("Scanner account is not authorized for this event.");
        } else {
          setScanResult("INVALID");
          setScanMessage("Could not verify this ticket. Do not admit.");
        }
        return;
      }
      const data = await response.json();
      if (data.result === "VERIFIED") {
        setScanResult("VERIFIED"); setScanMessage("First valid scan. Entry approved.");
      } else {
        setScanResult("INVALID"); setScanMessage("Already used, fake, revoked, or not for this event.");
      }
    } catch {
      setScanResult("SERVICE_UNAVAILABLE");
      setScanMessage("Connection or server error. Do not admit this ticket.");
    } finally { setScanBusy(false); }
  }

  async function startCamera() {
    if (!currentEvent) { setScanMessage("Create or select an event first."); return; }
    setScanResult(null); setScanMessage("");
    try {
      const scanner = new Html5Qrcode("qr-reader");
      scannerRef.current = scanner;
      await scanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 }, aspectRatio: 1 },
        async decoded => {
          if (handledRef.current || scanBusy) return;
          handledRef.current = true;
          await scanner.pause(true);
          await verifyToken(decoded);
          window.setTimeout(() => { handledRef.current = false; }, 1400);
          window.setTimeout(() => {
            if (scannerRef.current?.isScanning) scanner.resume();
          }, 1500);
        },
        () => undefined
      );
      setCameraOn(true);
    } catch (e: any) {
      setScanResult("SERVICE_UNAVAILABLE");
      setScanMessage(`Camera unavailable: ${e.message || "check camera permission"}.`);
    }
  }

  if (!configured || !supabase) {
    return <main className="shell"><section className="panel"><p className="eyebrow">CULTURE DAY / ENTRY CONTROL</p><h1>Configuration needed</h1><p>Add the Supabase URL and publishable key to your <code>.env</code> file. See README.</p></section></main>;
  }

  if (!session) return (
    <main className="auth-shell">
      <section className="auth-card">
        <p className="eyebrow">CULTURE DAY / ENTRY CONTROL</p>
        <h1>Ticket control<span>.</span></h1>
        <p className="muted">Secure ticket issuing and one-time entry verification.</p>
        <div className="auth-tabs">
          <button className={authMode==="signin"?"active":""} onClick={()=>{setAuthMode("signin");setNotice("");}}>Sign in</button>
          <button className={authMode==="signup"?"active":""} onClick={()=>{setAuthMode("signup");setNotice("");}}>Create account</button>
        </div>
        <label>Email address<input type="email" autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com"/></label>
        <label>Password<input type="password" autoComplete={authMode==="signin"?"current-password":"new-password"} value={password} onChange={e=>setPassword(e.target.value)} placeholder="At least 8 characters"/></label>
        <button className="primary full" disabled={authBusy || !email || password.length<8} onClick={authenticate}>{authBusy?"Please wait…":authMode==="signin"?"Sign in":"Create account"}</button>
        {notice && <p className="notice">{notice}</p>}
        <p className="tiny">Only authorized event staff should use this app. QR codes are not consumed by ordinary camera apps.</p>
      </section>
    </main>
  );

  return (
    <main className="shell">
      <header className="topbar">
        <div><p className="eyebrow">CULTURE DAY / ENTRY CONTROL</p><div className="brand">Ticket control<span>.</span></div></div>
        <div className="account"><span>{session.user.email}</span><button className="ghost" onClick={signOut}>Sign out</button></div>
      </header>
      <nav className="nav">
        <button className={tab==="tickets"?"selected":""} onClick={()=>setTab("tickets")}>Issue tickets</button>
        <button className={tab==="scanner"?"selected":""} onClick={()=>setTab("scanner")}>Scanner</button>
      </nav>

      {tab==="tickets" ? <section className="content">
        <div className="intro"><div><p className="eyebrow">EVENT MANAGEMENT</p><h1>Issue tickets</h1><p className="muted">Real tickets and test tickets are created as separate events.</p></div><div className="status-pill"><i/> Backend protected</div></div>
        <div className="ticket-grid">
          <article className="ticket-card">
            <p className="eyebrow">LIVE ENTRY</p><h2>200 real tickets</h2><p className="muted">For actual Culture Day admission. Each QR is unique and can be used once.</p>
            <button className="primary" disabled={eventBusy} onClick={()=>createTicketSet("REAL",200)}>{eventBusy?"Working…":"Generate 200 real tickets"}</button>
          </article>
          <article className="ticket-card test-card">
            <p className="eyebrow">SEPARATE TEST EVENT</p><h2>25 test tickets</h2><p className="muted">For scanner testing only. They cannot redeem real Culture Day tickets.</p>
            <button className="secondary" disabled={eventBusy} onClick={()=>createTicketSet("TEST",25)}>{eventBusy?"Working…":"Generate 25 test tickets"}</button>
          </article>
        </div>
        {notice && <p className="notice">{notice}</p>}
        <div className="info-strip"><strong>Important:</strong> The QR PDF is generated once when tickets are created. Save it immediately and do not share the raw QR tokens publicly.</div>
        <div className="history">
          <div className="section-head"><div><p className="eyebrow">THIS DEVICE</p><h2>Created events</h2></div><span className="muted">{events.length} saved</span></div>
          {events.length===0 ? <p className="empty">No event batches created on this device yet.</p> : events.map(event=><div className="event-row" key={event.id}><div><strong>{event.name}</strong><p className="tiny">{event.kind} · {event.count} tickets · {event.id}</p></div><button className="ghost" onClick={()=>{setSelectedEvent(event.id);setTab("scanner");}}>Open scanner</button></div>)}
        </div>
      </section> : <section className="content scanner-content">
        <div className="intro"><div><p className="eyebrow">ADMISSION DESK</p><h1>Scan ticket</h1><p className="muted">Only this authenticated scanner can redeem a ticket.</p></div><div className="status-pill"><i/> Online session</div></div>
        <label className="event-select">Event<select value={selectedEvent} onChange={e=>{setSelectedEvent(e.target.value);setScanResult(null);setScanMessage("");}}><option value="">Select event…</option>{events.map(e=><option key={e.id} value={e.id}>{e.name} — {e.kind}</option>)}</select></label>
        <div className="scanner-layout">
          <div className="camera-panel"><div id="qr-reader"/>{!cameraOn ? <button className="primary full" disabled={!currentEvent} onClick={startCamera}>Start camera scanner</button> : <button className="secondary full" onClick={stopCamera}>Stop camera</button>}</div>
          <div className="result-panel">
            <p className="eyebrow">SCAN RESULT</p>
            <div className={`result-display ${scanResult==="VERIFIED"?"good":scanResult==="INVALID"?"bad":scanResult==="SERVICE_UNAVAILABLE"?"offline":""}`}>
              {scanBusy ? <div className="loading-dot"/> : scanResult==="VERIFIED" ? <><div className="checkmark">✓</div><div className="result-word">VERIFIED</div></> : scanResult==="INVALID" ? <><div className="cross">×</div><div className="result-word">INVALID</div></> : scanResult==="SERVICE_UNAVAILABLE" ? <><div className="cross">!</div><div className="result-word">OFFLINE</div></> : <><div className="scan-icon">⌗</div><div className="result-word idle">READY</div></>}
            </div>
            <p className="result-message">{scanBusy?"Checking ticket securely…":scanMessage || "Scan a QR code to check admission."}</p>
            <div className="manual"><label>Manual token entry<input value={manualToken} onChange={e=>setManualToken(e.target.value)} placeholder="Paste QR token"/></label><button className="secondary full" disabled={!manualToken.trim() || !currentEvent || scanBusy} onClick={()=>verifyToken(manualToken)}>Verify token</button></div>
            <p className="tiny">If the backend is unavailable, the scanner fails closed. Never admit on an OFFLINE result.</p>
          </div>
        </div>
      </section>}
      <footer>Culture Day · Secure entry system</footer>
    </main>
  );
}
