import { useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Eye, EyeOff, Loader2, BookOpen, Users, TrendingUp, Award } from "lucide-react";
import { CACHE_KEY } from "@/lib/authCache";
import { getOrgSubdomainUrl, getSubdomain } from "@/hooks/useSubdomain";
import { useOrgAuthBranding } from "@/hooks/useOrgAuthBranding";

const NAVY = "#0b1d35";
const NAVY_MID = "#0f2847";
const TEAL = "#24abbc";
const TEAL_LIGHT = "#4ad9e0";

const features = [
  { icon: BookOpen, text: "Build & sell courses in minutes" },
  { icon: Users, text: "Manage unlimited students" },
  { icon: TrendingUp, text: "Built-in analytics & revenue tracking" },
  { icon: Award, text: "Automated certificates & completions" },
];

export default function LoginPage() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  // Support both "returnTo" and "returnPath" for backwards compat
  const returnTo = params.get("returnTo") ?? params.get("returnPath") ?? "";

  // Desktop app context: detect via context=desktop param OR returnTo pointing to app routes
  const contextParam = params.get("context") ?? "";
  const isDesktop = contextParam === "desktop" || ["/creator", "/studio", "/quiz-creator", "/quiz-creator-app"].some((p) =>
    returnTo.startsWith(p)
  );

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");

  // Org white-labeling
  const { branding, primary, buttonText, displayName } = useOrgAuthBranding();
  const isOrgSubdomain = !!branding;

  const utils = trpc.useUtils();
  const login = trpc.customAuth.login.useMutation({
    onSuccess: (data) => {
      // Seed the auth.me cache immediately so DashboardLayout doesn't flash
      // the "Sign in" screen before the background refetch completes.
      if (data.user) {
        utils.auth.me.setData(undefined, data.user as never);
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(data.user)); } catch {}
      }

      // If we're at the root domain and the user belongs to an org,
      // redirect immediately to their org subdomain — zero delay.
      const isAtRoot = !getSubdomain();
      const orgSlug = (data as any).orgSlug as string | null;
      if (isAtRoot && orgSlug) {
        // Cache the orgSlug so Home.tsx can redirect instantly without waiting for API
        try { localStorage.setItem("teachific_org_slug", orgSlug); } catch {}
        const dest = getOrgSubdomainUrl(orgSlug, returnTo || "/lms");
        window.location.href = dest;
        return;
      }

      // Platform admins or subdomain logins: stay on current domain
      navigate(returnTo || "/lms");
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    login.mutate({ email: email.trim(), password: password.trim() });
  };

  // ── Desktop-app minimal login ────────────────────────────────────────────
  if (isDesktop) {
    const appName = returnTo.startsWith("/studio")
      ? "Teachific Studio™"
      : returnTo.startsWith("/quiz-creator")
      ? "Teachific QuizMaker™"
      : contextParam === "desktop" && !returnTo
      ? "Teachific"
      : "TeachificCreator™";

    return (
      <div className="min-h-screen flex flex-col justify-center items-center bg-white px-8">
        {/* Logo */}
        <div className="mb-8 text-center">
          <div className="flex items-baseline gap-0.5 justify-center">
            <span
              className="text-3xl font-bold tracking-tight"
              style={{ color: NAVY, fontFamily: "'Plus Jakarta Sans', sans-serif" }}
            >
              teach
            </span>
            <span
              className="text-3xl font-bold tracking-tight"
              style={{ color: TEAL, fontFamily: "'Plus Jakarta Sans', sans-serif" }}
            >
              ific
            </span>
            <span
              className="text-sm font-bold ml-0.5"
              style={{ color: TEAL, verticalAlign: "super", fontSize: "0.55em" }}
            >
              ™
            </span>
          </div>
          <p
            className="text-xs font-semibold tracking-widest uppercase mt-1"
            style={{ color: `${TEAL}99` }}
          >
            {appName}
          </p>
        </div>

        <div className="w-full max-w-sm">
          <div className="mb-6 text-center">
            <h2
              className="text-xl font-bold mb-1"
              style={{ color: NAVY, fontFamily: "'Plus Jakarta Sans', sans-serif" }}
            >
              Sign in
            </h2>
            <p className="text-sm text-slate-500">Use your Teachific account credentials</p>
          </div>

          {error && (
            <Alert className="mb-5 border-red-200 bg-red-50">
              <AlertDescription className="text-red-700 text-sm">{error}</AlertDescription>
            </Alert>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-1.5">
              <Label
                htmlFor="email-d"
                className="text-sm font-medium"
                style={{ color: NAVY }}
              >
                Email address
              </Label>
              <Input
                id="email-d"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                autoComplete="email"
                className="h-11 border-slate-200 focus:border-[#24abbc] focus:ring-[#24abbc]/20 text-slate-800 placeholder:text-slate-400"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label
                  htmlFor="password-d"
                  className="text-sm font-medium"
                  style={{ color: NAVY }}
                >
                  Password
                </Label>
                <Link
                  href="/forgot-password"
                  className="text-xs font-medium transition-colors hover:opacity-80"
                  style={{ color: TEAL }}
                >
                  Forgot password?
                </Link>
              </div>
              <div className="relative">
                <Input
                  id="password-d"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  autoComplete="current-password"
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

            <Button
              type="submit"
              disabled={login.isPending}
              className="w-full h-11 font-semibold text-white rounded-lg transition-all shadow-sm"
              style={{ background: `linear-gradient(135deg, ${TEAL} 0%, #15b8c0 100%)` }}
            >
              {login.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Signing in...
                </>
              ) : (
                "Sign in"
              )}
            </Button>
          </form>
        </div>
      </div>
    );
  }

  // ── Standard web login ───────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex">
      {/* ── Left panel: brand (hidden on org subdomains) ───────────── */}
      {!isOrgSubdomain && <div
        className="hidden lg:flex lg:w-[52%] flex-col justify-between p-12 relative overflow-hidden"
        style={{ background: `linear-gradient(145deg, ${NAVY} 0%, ${NAVY_MID} 60%, #0d3352 100%)` }}
      >
        {/* Decorative glows */}
        <div
          className="absolute -top-24 -right-24 w-96 h-96 rounded-full opacity-10"
          style={{ background: `radial-gradient(circle, ${TEAL_LIGHT}, transparent 70%)` }}
        />
        <div
          className="absolute -bottom-32 -left-16 w-80 h-80 rounded-full opacity-8"
          style={{ background: `radial-gradient(circle, ${TEAL}, transparent 70%)` }}
        />
        <div
          className="absolute top-1/2 right-0 w-px h-64 -translate-y-1/2 opacity-20"
          style={{ background: `linear-gradient(to bottom, transparent, ${TEAL_LIGHT}, transparent)` }}
        />

        {/* Logo */}
        <div className="relative z-10">
          <div className="flex items-baseline gap-0.5">
            <span
              className="text-3xl font-bold text-white tracking-tight"
              style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}
            >
              teach
            </span>
            <span
              className="text-3xl font-bold tracking-tight"
              style={{ color: TEAL_LIGHT, fontFamily: "'Plus Jakarta Sans', sans-serif" }}
            >
              ific
            </span>
            <span
              className="text-sm font-bold ml-0.5"
              style={{ color: TEAL_LIGHT, verticalAlign: "super", fontSize: "0.55em" }}
            >
              ™
            </span>
          </div>
          <p
            className="text-xs font-semibold tracking-widest uppercase mt-1"
            style={{ color: `${TEAL_LIGHT}80` }}
          >
            Learning Management Platform
          </p>
        </div>

        {/* Hero copy */}
        <div className="relative z-10 space-y-8">
          <div>
            <h1
              className="text-4xl font-bold text-white leading-tight mb-4"
              style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}
            >
              Your knowledge.
              <br />
              <span style={{ color: TEAL_LIGHT }}>Your school.</span>
              <br />
              Your revenue.
            </h1>
            <p className="text-white/60 text-base leading-relaxed max-w-sm">
              Join thousands of educators who turned their expertise into a thriving online school
              with Teachific.
            </p>
          </div>

          {/* Feature list */}
          <div className="space-y-3">
            {features.map(({ icon: Icon, text }) => (
              <div key={text} className="flex items-center gap-3">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                  style={{ background: `${TEAL}25`, border: `1px solid ${TEAL}40` }}
                >
                  <Icon className="w-4 h-4" style={{ color: TEAL_LIGHT }} />
                </div>
                <span className="text-white/75 text-sm">{text}</span>
              </div>
            ))}
          </div>

          {/* Stats */}
          <div className="flex items-center gap-6 pt-2">
            <div>
              <p className="text-2xl font-bold text-white">10K+</p>
              <p className="text-white/45 text-xs">Courses created</p>
            </div>
            <div className="w-px h-10 bg-white/15" />
            <div>
              <p className="text-2xl font-bold text-white">250K+</p>
              <p className="text-white/45 text-xs">Active learners</p>
            </div>
            <div className="w-px h-10 bg-white/15" />
            <div>
              <p className="text-2xl font-bold text-white">98%</p>
              <p className="text-white/45 text-xs">Satisfaction</p>
            </div>
          </div>
        </div>

        <p className="relative z-10 text-white/25 text-xs">
          © {new Date().getFullYear()} Teachific™. All rights reserved.
        </p>
      </div>}

      {/* ── Right panel: form ───────────────────────────────────────── */}
      <div className="flex-1 flex flex-col justify-center items-center bg-white px-8 py-12">
        {/* Logo: org branding on subdomain, Teachific on root */}
        <div className="mb-8 text-center">
          {isOrgSubdomain ? (
            branding?.logoUrl ? (
              <img src={branding.logoUrl} alt={displayName} className="h-12 max-w-[200px] object-contain mx-auto mb-2" />
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
              Welcome back
            </h2>
            <p className="text-sm text-slate-500">
              {isOrgSubdomain ? `Sign in to ${displayName}` : "Sign in to your Teachific account"}
            </p>
          </div>

          {error && (
            <Alert className="mb-5 border-red-200 bg-red-50">
              <AlertDescription className="text-red-700 text-sm">{error}</AlertDescription>
            </Alert>
          )}

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

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="password" className="text-sm font-medium" style={{ color: NAVY }}>
                  Password
                </Label>
                <Link
                  href="/forgot-password"
                  className="text-xs font-medium transition-colors hover:opacity-80"
                  style={{ color: TEAL }}
                >
                  Forgot password?
                </Link>
              </div>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  autoComplete="current-password"
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

            <Button
              type="submit"
              disabled={login.isPending}
              className="w-full h-11 font-semibold rounded-lg transition-all shadow-sm"
              style={{
                background: isOrgSubdomain ? primary : `linear-gradient(135deg, ${TEAL} 0%, #15b8c0 100%)`,
                color: buttonText,
              }}
            >
              {login.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Signing in...
                </>
              ) : (
                "Sign in"
              )}
            </Button>
          </form>

          <div className="mt-6 text-center">
            <p className="text-sm text-slate-500">
              Don't have an account?{" "}
              <Link
                href="/register"
                className="font-semibold transition-colors hover:opacity-80"
                style={{ color: isOrgSubdomain ? primary : TEAL }}
              >
                {isOrgSubdomain ? "Create account" : "Start for free"}
              </Link>
            </p>
          </div>

          <div className="mt-8 pt-6 border-t border-slate-100 text-center">
            <p className="text-xs text-slate-400">
              By signing in you agree to our{" "}
              <a
                href="/policies/teachific"
                className="underline hover:text-slate-600 transition-colors"
              >
                Terms of Service
              </a>{" "}
              and{" "}
              <a
                href="/policies/teachific"
                className="underline hover:text-slate-600 transition-colors"
              >
                Privacy Policy
              </a>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
