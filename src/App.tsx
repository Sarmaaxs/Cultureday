import { useEffect, useMemo, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { Camera } from "@capacitor/camera";
import { Capacitor } from "@capacitor/core";
import QRCode from "qrcode";
import { jsPDF } from "jspdf";
import { FUNCTIONS_URL, configured, supabase } from "./supabase";

type Ticket = { number: number; token: string };
type TicketEvent = { id: string; name: string; count: number; kind: "REAL" | "TEST" };
type AuthMode = "signin" | "signup";
type Result = "VERIFIED" | "INVALID" | "SERVICE_UNAVAILABLE" | null;

const STORE_KEY = "culture-day-events-v1";
const TICKETS_KEY = "culture-day-ticket-codes-v1";

async function downloadTicketsPdf(event: TicketEvent, tickets: Ticket[], onlyIndex?: number) {
  const selected = onlyIndex === undefined ? tickets : [tickets[onlyIndex]].filter(Boolean);
  if (!selected.length) throw new Error("Ticket code is not saved on this device.");
  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const cols = onlyIndex === undefined ? 3 : 1;
  const rowsPerPage = onlyIndex === undefined ? 4 : 1;
  const cellW = onlyIndex === undefined ? 63 : 190;
  const cellH = onlyIndex === undefined ? 68 : 277;
  const cardW = onlyIndex === undefined ? 58 : 90;
  const cardH = onlyIndex === undefined ? 63 : 112;
  const startX = onlyIndex === undefined ? 10 : 60;
  const startY = onlyIndex === undefined ? 10 : 92;
  for (let i = 0; i < selected.length; i++) {
    if (i > 0 && i % (cols * rowsPerPage) === 0) pdf.addPage();
    const pos = i % (cols * rowsPerPage);
    const x = onlyIndex === undefined ? startX + (pos % cols) * cellW : startX;
    const y = onlyIndex === undefined ? startY + Math.floor(pos / cols) * cellH : startY;
    pdf.setDrawColor(25, 25, 25);
    pdf.roundedRect(x, y, cardW, cardH, 2, 2);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(onlyIndex === undefined ? 10 : 17);
    pdf.text("CULTURE DAY", x + cardW / 2, y + (onlyIndex === undefined ? 8 : 15), { align: "center" });
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(onlyIndex === undefined ? 8 : 11);
    pdf.text(`${event.kind} TICKET  #${String(selected[i].number).padStart(3, "0")}`, x + cardW / 2, y + (onlyIndex === undefined ? 14 : 23), { align: "center" });
    const qrSize = onlyIndex === undefined ? 40 : 66;
    const qr = await QRCode.toDataURL(selected[i].token, { errorCorrectionLevel: "H", margin: 1, width: 500 });
    pdf.addImage(qr, "PNG", x + (cardW - qrSize) / 2, y + (onlyIndex === undefined ? 17 : 31), qrSize, qrSize);
    pdf.setFontSize(onlyIndex === undefined ? 6 : 9);
    pdf.text("ONE ENTRY", x + cardW / 2, y + (onlyIndex === undefined ? 60 : 105), { align: "center" });
  }
  pdf.save(onlyIndex === undefined
    ? `culture-day-${event.kind.toLowerCase()}-tickets.pdf`
    : `culture-day-${event.kind.toLowerCase()}-ticket-${String(selected[0].number).padStart(3, "0")}.pdf`);
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
  const [showPassword, setShowPassword] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<"tickets" | "scanner">("tickets");
  const [events, setEvents] = useState<TicketEvent[]>([]);
  const [ticketSets, setTicketSets] = useState<Record<string, Ticket[]>>({});
  const [selectedEvent, setSelectedEvent] = useState("");
  const [selectedTicketNumber, setSelectedTicketNumber] = useState("1");
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
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "[]") as TicketEvent[];
      const savedTickets = JSON.parse(localStorage.getItem(TICKETS_KEY) || "{}") as Record<string, Ticket[]>;
      setEvents(saved);
      setTicketSets(savedTickets);
      if (saved.length) setSelectedEvent(saved[0].id);
    } catch { /* ignore malformed local cache */ }
  }, []);

  useEffect(() => () => {
    if (scannerRef.current?.isScanning) scannerRef.current.stop().catch(() => undefined);
  }, []);

  const currentEvent = useMemo(() => events.find(e => e.id === selectedEvent), [events, selectedEvent]);
  const currentTickets = currentEvent ? (ticketSets[currentEvent.id] || []) : [];

  async function authenticate() {
    if (!supabase) return;
    setAuthBusy(true); setNotice("");
    try {
      if (authMode === "signup") {
        const { data, error } = await supabase.auth.signUp({ email: email.trim(), password });
        if (error) throw error;
        setNotice(!data.session ? "Account created. Confirm your email, then sign in." : "Account created.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
      }
    } catch (e: any) { setNotice(explainError(e.message || "Authentication failed.")); }
    finally { setAuthBusy(false); }
  }

  async function signOut() {
    await stopCamera();
    await supabase?.auth.signOut();
    setScanResult(null);
  }

  async function createTicketSet(kind: "REAL" | "TEST", count: number) {
    if (!supabase || !session?.access_token) return;
    setEventBusy(true); setNotice("");
    try {
      const response = await fetch(`${FUNCTIONS_URL}/create-event-tickets`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.access_token}`, "apikey": import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
        body: JSON.stringify({ name: kind === "REAL" ? "Culture Day" : "Culture Day TEST", count })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Ticket creation failed (${response.status}).`);
      const event: TicketEvent = { id: payload.event_id, name: kind === "REAL" ? "Culture Day" : "Culture Day TEST", count: payload.count, kind };
      const tickets = payload.tickets as Ticket[];
      const nextEvents = [event, ...events];
      const nextSets = { ...ticketSets, [event.id]: tickets };
      setEvents(nextEvents); setTicketSets(nextSets); setSelectedEvent(event.id); setSelectedTicketNumber("1");
      localStorage.setItem(STORE_KEY, JSON.stringify(nextEvents));
      localStorage.setItem(TICKETS_KEY, JSON.stringify(nextSets));
      setNotice(`${tickets.length} tickets created. Choose Download all or download them one at a time.`);
    } catch (e: any) {
      setNotice(e.message || "Could not create tickets.");
    } finally { setEventBusy(false); }
  }

  async function stopCamera() {
    if (scannerRef.current?.isScanning) {
      try { await scannerRef.current.stop(); } catch { /* already stopped */ }
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
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.access_token}`, "apikey": import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
        body: JSON.stringify({ event_id: currentEvent.id, token })
      });
      if (!response.ok) {
        setScanResult(response.status === 503 ? "SERVICE_UNAVAILABLE" : "INVALID");
        setScanMessage(response.status === 401 || response.status === 403 ? "Scanner account is not authorized." : "Could not verify. Do not admit.");
        return;
      }
      const data = await response.json();
      if (data.result === "VERIFIED") { setScanResult("VERIFIED"); setScanMessage("Entry approved."); }
      else { setScanResult("INVALID"); setScanMessage("Already used or not valid for this event."); }
    } catch {
      setScanResult("SERVICE_UNAVAILABLE");
      setScanMessage("Could not reach the verification service. Do not admit.");
    } finally { setScanBusy(false); }
  }

  async function startCamera() {
    if (!currentEvent) return;
    setScanResult(null); setScanMessage("");
    try {
      if (Capacitor.isNativePlatform()) {
        let permission = await Camera.checkPermissions();
        if (permission.camera !== "granted") permission = await Camera.requestPermissions({ permissions: ["camera"] });
        if (permission.camera !== "granted") throw new Error("Camera permission denied.");
      }
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera access is unavailable. Allow camera access and reopen the app.");
      const permissionStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      permissionStream.getTracks().forEach(track => track.stop());
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
          window.setTimeout(() => { if (scannerRef.current?.isScanning) scanner.resume(); }, 1500);
        },
        () => undefined
      );
      setCameraOn(true);
    } catch (e: any) {
      setScanResult("SERVICE_UNAVAILABLE");
      const msg = String(e?.message || e || "Camera permission denied.");
      setScanMessage(/permission|denied|notallowed/i.test(msg)
        ? "Allow Camera permission for Culture Day Tickets in Android Settings, then try again."
        : `Camera could not start: ${msg}`);
    }
  }

  if (!configured || !supabase) return <main className="auth-shell"><section className="auth-card"><h1>Setup required</h1><p className="muted">Add the Supabase settings to the .env file.</p></section></main>;

  if (!session) return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="app-mark" aria-hidden="true"><span /></div>
        <h1>Culture Day</h1>
        <div className="auth-tabs">
          <button className={authMode === "signin" ? "active" : ""} onClick={() => { setAuthMode("signin"); setNotice(""); }}>Sign in</button>
          <button className={authMode === "signup" ? "active" : ""} onClick={() => { setAuthMode("signup"); setNotice(""); }}>Create account</button>
        </div>
        <label>Email<input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email address" /></label>
        <label>Password<div className="password-wrap"><input type={showPassword ? "text" : "password"} autoComplete={authMode === "signin" ? "current-password" : "new-password"} value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" /><button type="button" className="show-password" onClick={() => setShowPassword(v => !v)}>{showPassword ? "Hide" : "Show"}</button></div></label>
        <button className="primary full" disabled={authBusy || !email || password.length < 8} onClick={authenticate}>{authBusy ? "Please wait…" : authMode === "signin" ? "Sign in" : "Create account"}</button>
        {notice && <p className="notice">{notice}</p>}
      </section>
    </main>
  );

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand-lockup"><div className="app-mark small" aria-hidden="true"><span /></div><div className="brand">Culture Day</div></div>
        <div className="account"><span>{session.user.email}</span><button className="ghost" onClick={signOut}>Sign out</button></div>
      </header>
      <nav className="nav">
        <button className={tab === "tickets" ? "selected" : ""} onClick={() => setTab("tickets")}>Tickets</button>
        <button className={tab === "scanner" ? "selected" : ""} onClick={() => setTab("scanner")}>Scanner</button>
      </nav>
      {tab === "tickets" ? <section className="content">
        <h1>Tickets</h1>
        <div className="ticket-grid">
          <article className="ticket-card"><h2>200 tickets</h2><button className="primary" disabled={eventBusy} onClick={() => createTicketSet("REAL", 200)}>{eventBusy ? "Creating…" : "Generate tickets"}</button></article>
          <article className="ticket-card test-card"><h2>25 test tickets</h2><button className="secondary" disabled={eventBusy} onClick={() => createTicketSet("TEST", 25)}>{eventBusy ? "Creating…" : "Generate test tickets"}</button></article>
        </div>
        {notice && <p className="notice">{notice}</p>}
        <div className="history">
          <div className="section-head"><h2>Created batches</h2><span className="muted">{events.length}</span></div>
          {!events.length ? <p className="empty">No tickets yet.</p> : events.map(event => {
            const saved = ticketSets[event.id] || [];
            return <div className="event-row ticket-batch" key={event.id}>
              <div className="batch-title"><strong>{event.name}</strong><span className="tiny">{event.kind} · {event.count}</span></div>
              <div className="batch-actions">
                <button className="primary" disabled={!saved.length} onClick={() => downloadTicketsPdf(event, saved).catch(e => setNotice(e.message))}>Download all</button>
                <select aria-label="Ticket number" value={event.id === selectedEvent ? selectedTicketNumber : "1"} onChange={e => { setSelectedEvent(event.id); setSelectedTicketNumber(e.target.value); }}>
                  {Array.from({ length: saved.length }, (_, i) => <option key={i + 1} value={String(i + 1)}>#{String(i + 1).padStart(3, "0")}</option>)}
                </select>
                <button className="secondary" disabled={!saved.length} onClick={() => downloadTicketsPdf(event, saved, Number(event.id === selectedEvent ? selectedTicketNumber : "1") - 1).catch(e => setNotice(e.message))}>One ticket</button>
                <button className="ghost" onClick={() => { setSelectedEvent(event.id); setTab("scanner"); }}>Scan</button>
              </div>
            </div>;
          })}
        </div>
      </section> : <section className="content scanner-content">
        <h1>Scanner</h1>
        <label className="event-select">Event<select value={selectedEvent} onChange={e => { setSelectedEvent(e.target.value); setScanResult(null); setScanMessage(""); }}><option value="">Select event</option>{events.map(e => <option key={e.id} value={e.id}>{e.name} — {e.kind}</option>)}</select></label>
        <div className="scanner-layout">
          <div className="camera-panel"><div id="qr-reader" />{!cameraOn ? <button className="primary full" disabled={!currentEvent} onClick={startCamera}>Start camera</button> : <button className="secondary full" onClick={stopCamera}>Stop camera</button>}</div>
          <div className="result-panel">
            <div className={`result-display ${scanResult === "VERIFIED" ? "good" : scanResult === "INVALID" ? "bad" : scanResult === "SERVICE_UNAVAILABLE" ? "offline" : ""}`}>
              {scanBusy ? <div className="loading-dot" /> : scanResult === "VERIFIED" ? <><div className="checkmark">✓</div><div className="result-word">VERIFIED</div></> : scanResult === "INVALID" ? <><div className="cross">×</div><div className="result-word">INVALID</div></> : scanResult === "SERVICE_UNAVAILABLE" ? <><div className="cross">!</div><div className="result-word">OFFLINE</div></> : <><div className="scan-icon">⌗</div><div className="result-word idle">READY</div></>}
            </div>
            <p className="result-message">{scanBusy ? "Checking…" : scanMessage}</p>
            <div className="manual"><label>Enter code<input value={manualToken} onChange={e => setManualToken(e.target.value)} placeholder="Ticket code" /></label><button className="secondary full" disabled={!manualToken.trim() || !currentEvent || scanBusy} onClick={() => verifyToken(manualToken)}>Verify</button></div>
          </div>
        </div>
      </section>}
    </main>
  );
}
