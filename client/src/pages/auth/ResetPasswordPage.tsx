import { useState, useEffect } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Eye, EyeOff, Loader2, CheckCircle2, LockKeyhole } from "lucide-react";
import { useOrgAuthBranding } from "@/hooks/useOrgAuthBranding";

const NAVY = "#0b1d35";
const NAVY_MID = "#0f2847";
const TEAL = "#24abbc";
const TEAL_LIGHT = "#4ad9e0";

export default function ResetPasswordPage() {
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const { branding, primary, buttonText, displayName } = useOrgAuthBranding();
  const isOrgSubdomain = !!branding;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("token");
    if (t) setToken(t);
    else setError("Invalid or missing reset token. Please request a new password reset link.");
  }, []);

  const reset = trpc.customAuth.resetPassword.useMutation({
    onSuccess: () => setSuccess(true),
    onError: (err) => setError(err.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const normalizedPassword = password.trim();
    const normalizedConfirm = confirm.trim();
    if (normalizedPassword !== normalizedConfirm) { setError("Passwords do not match."); return; }
    setError("");
    reset.mutate({ token, newPassword: normalizedPassword });
  };

  if (success) {
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
            <CheckCircle2 className="w-16 h-16 mx-auto mb-4" style={{ color: TEAL_LIGHT }} />
            <h2 className="text-2xl font-semibold text-white mb-3">Password updated</h2>
            <p className="text-white/60 leading-relaxed mb-6">
              Your password has been successfully reset. You can now sign in with your new password.
            </p>
            <Link href="/login">
              <Button
                className="font-semibold w-full text-white"
                style={{ background: `linear-gradient(135deg, ${TEAL} 0%, #15b8c0 100%)` }}
              >
                Sign In
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
        <div className="absolute -top-24 -right-24 w-96 h-96 rounded-full opacity-10"
          style={{ background: `radial-gradient(circle, ${TEAL_LIGHT}, transparent 70%)` }} />
        <div className="absolute -bottom-32 -left-16 w-80 h-80 rounded-full opacity-8"
          style={{ background: `radial-gradient(circle, ${TEAL}, transparent 70%)` }} />

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
            <LockKeyhole className="w-8 h-8" style={{ color: TEAL_LIGHT }} />
          </div>
          <div>
            <h1
              className="text-3xl font-bold text-white leading-tight mb-3"
              style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}
            >
              New password.<br />
              <span style={{ color: TEAL_LIGHT }}>Fresh start.</span>
            </h1>
            <p className="text-white/60 text-base leading-relaxed max-w-sm">
              Choose a strong password to protect your Teachific account. We recommend at least 12 characters with a mix of letters, numbers, and symbols.
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
          <div className="mb-8">
            <h2
              className="text-2xl font-bold mb-1"
              style={{ color: NAVY, fontFamily: "'Plus Jakarta Sans', sans-serif" }}
            >
              Set a new password
            </h2>
            <p className="text-sm text-slate-500">Choose a strong password for your account.</p>
          </div>

          {error && (
            <Alert className="mb-5 border-red-200 bg-red-50">
              <AlertDescription className="text-red-700 text-sm">{error}</AlertDescription>
            </Alert>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-sm font-medium" style={{ color: NAVY }}>New password</Label>
              <div className="relative">
                <Input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  required
                  minLength={8}
                  className="h-11 border-slate-200 focus:border-[#24abbc] focus:ring-[#24abbc]/20 text-slate-800 placeholder:text-slate-400 pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm font-medium" style={{ color: NAVY }}>Confirm new password</Label>
              <Input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Repeat your password"
                required
                className="h-11 border-slate-200 focus:border-[#24abbc] focus:ring-[#24abbc]/20 text-slate-800 placeholder:text-slate-400"
              />
              {confirm.length > 0 && password !== confirm && (
                <p className="text-red-600 text-xs">Passwords do not match</p>
              )}
            </div>

            <Button
              type="submit"
              disabled={reset.isPending || !token}
              className="w-full h-11 font-semibold rounded-lg transition-all shadow-sm"
              style={{
                background: isOrgSubdomain ? primary : `linear-gradient(135deg, ${TEAL} 0%, #15b8c0 100%)`,
                color: buttonText,
              }}
            >
              {reset.isPending
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Updating...</>
                : "Update password"}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
