import { useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, MailCheck, ArrowLeft, KeyRound } from "lucide-react";
import { useOrgAuthBranding } from "@/hooks/useOrgAuthBranding";

const NAVY = "#0b1d35";
const NAVY_MID = "#0f2847";
const TEAL = "#24abbc";
const TEAL_LIGHT = "#4ad9e0";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  const { branding, primary, buttonText, displayName } = useOrgAuthBranding();
  const isOrgSubdomain = !!branding;

  const forgot = trpc.customAuth.forgotPassword.useMutation({
    onSuccess: () => setSent(true),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    forgot.mutate({ email: email.trim() });
  };

  if (sent) {
    return (
      <div
        className="min-h-screen flex items-center justify-center p-8"
        style={{ background: `linear-gradient(145deg, ${NAVY} 0%, ${NAVY_MID} 60%, #0d3352 100%)` }}
      >
        <div className="w-full max-w-md text-center">
          <div className="flex items-baseline gap-0.5 justify-center mb-8">
            <span className="text-3xl font-bold text-white tracking-tight" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>teach</span>
            <span className="text-3xl font-bold tracking-tight" style={{ color: TEAL_LIGHT, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>ific</span>
            <span className="text-sm font-bold ml-0.5" style={{ color: TEAL_LIGHT, verticalAlign: "super", fontSize: "0.55em" }}>™</span>
          </div>
          <div className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-10 shadow-2xl">
            <MailCheck className="w-16 h-16 mx-auto mb-4" style={{ color: TEAL_LIGHT }} />
            <h2 className="text-2xl font-semibold text-white mb-3">Check your inbox</h2>
            <p className="text-white/60 leading-relaxed mb-6">
              If an account exists for{" "}
              <span className="font-medium" style={{ color: TEAL_LIGHT }}>{email}</span>,
              we've sent a password reset link. Check your spam folder if you don't see it within a few minutes.
            </p>
            <Link href="/login">
              <Button
                className="font-semibold w-full text-white"
                style={{ background: `linear-gradient(135deg, ${TEAL} 0%, #15b8c0 100%)` }}
              >
                Back to Sign In
              </Button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex">
      {/* ── Left panel: brand (hidden on org subdomains) ───────────── */}
      {!isOrgSubdomain && <div
        className="hidden lg:flex lg:w-[52%] flex-col justify-between p-12 relative overflow-hidden"
        style={{ background: `linear-gradient(145deg, ${NAVY} 0%, ${NAVY_MID} 60%, #0d3352 100%)` }}
      >
        <div
          className="absolute -top-24 -right-24 w-96 h-96 rounded-full opacity-10"
          style={{ background: `radial-gradient(circle, ${TEAL_LIGHT}, transparent 70%)` }}
        />
        <div
          className="absolute -bottom-32 -left-16 w-80 h-80 rounded-full opacity-8"
          style={{ background: `radial-gradient(circle, ${TEAL}, transparent 70%)` }}
        />

        {/* Logo */}
        <div className="relative z-10">
          <div className="flex items-baseline gap-0.5">
            <span className="text-3xl font-bold text-white tracking-tight" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>teach</span>
            <span className="text-3xl font-bold tracking-tight" style={{ color: TEAL_LIGHT, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>ific</span>
            <span className="text-sm font-bold ml-0.5" style={{ color: TEAL_LIGHT, verticalAlign: "super", fontSize: "0.55em" }}>™</span>
          </div>
          <p className="text-xs font-semibold tracking-widest uppercase mt-1" style={{ color: `${TEAL_LIGHT}80` }}>
            Learning Management Platform
          </p>
        </div>

        <div className="relative z-10 space-y-6">
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center"
            style={{ background: `${TEAL}25`, border: `1px solid ${TEAL}40` }}
          >
            <KeyRound className="w-8 h-8" style={{ color: TEAL_LIGHT }} />
          </div>
          <div>
            <h1
              className="text-3xl font-bold text-white leading-tight mb-3"
              style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}
            >
              Password reset<br />
              <span style={{ color: TEAL_LIGHT }}>made simple.</span>
            </h1>
            <p className="text-white/60 text-base leading-relaxed max-w-sm">
              Enter your email address and we'll send you a secure link to reset your password. It only takes a moment.
            </p>
          </div>
        </div>

        <p className="relative z-10 text-white/25 text-xs">
          © {new Date().getFullYear()} Teachific™. All rights reserved.
        </p>
      </div>}

      {/* ── Right panel: form ───────────────────────────────────────── */}
      <div className="flex-1 flex flex-col justify-center items-center bg-white px-8 py-12">
        {/* Logo */}
        <div className="mb-8 text-center">
          {isOrgSubdomain ? (
            branding?.logoUrl ? (
              <img src={branding.logoUrl} alt={displayName} className="h-12 max-w-[200px] object-contain mx-auto" />
            ) : (
              <h1 className="text-2xl font-bold" style={{ color: primary }}>{displayName}</h1>
            )
          ) : (
            <div className="lg:hidden flex items-baseline gap-0.5 justify-center">
              <span className="text-3xl font-bold tracking-tight" style={{ color: NAVY, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>teach</span>
              <span className="text-3xl font-bold tracking-tight" style={{ color: TEAL, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>ific</span>
              <span className="text-sm font-bold ml-0.5" style={{ color: TEAL, verticalAlign: "super", fontSize: "0.55em" }}>™</span>
            </div>
          )}
        </div>

        <div className="w-full max-w-sm">
          <Link
            href="/login"
            className="inline-flex items-center gap-1.5 text-sm mb-8 transition-colors hover:opacity-70"
            style={{ color: isOrgSubdomain ? primary : TEAL }}
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Back to sign in
          </Link>

          <div className="mb-8">
            <h2
              className="text-2xl font-bold mb-1"
              style={{ color: NAVY, fontFamily: "'Plus Jakarta Sans', sans-serif" }}
            >
              Forgot your password?
            </h2>
            <p className="text-sm text-slate-500">Enter your email and we'll send you a reset link.</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-1.5">
              <Label htmlFor="email" className="text-sm font-medium" style={{ color: NAVY }}>
                Email address
              </Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                autoComplete="email"
                className="h-11 border-slate-200 focus:border-[#24abbc] focus:ring-[#24abbc]/20 text-slate-800 placeholder:text-slate-400"
              />
            </div>
            <Button
              type="submit"
              disabled={forgot.isPending}
              className="w-full h-11 font-semibold rounded-lg transition-all shadow-sm"
              style={{
                background: isOrgSubdomain ? primary : `linear-gradient(135deg, ${TEAL} 0%, #15b8c0 100%)`,
                color: buttonText,
              }}
            >
              {forgot.isPending
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Sending...</>
                : "Send reset link"}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
