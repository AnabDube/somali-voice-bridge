import { useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Mic, ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";

const ForgotPassword = () => {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });

    if (error) {
      toast.error(error.message);
    } else {
      setSent(true);
      toast.success("Check your email for a reset link");
    }
    setLoading(false);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm text-center">
        <Link to="/" className="mb-6 inline-flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-gold">
            <Mic className="h-5 w-5 text-foreground" />
          </div>
          <span className="font-display text-xl font-bold tracking-tight">Somali Voice Bridge</span>
        </Link>
        <h1 className="mt-4 font-display text-2xl font-bold">Reset your password</h1>

        {sent ? (
          <div className="mt-6">
            <p className="text-sm text-muted-foreground">We've sent a reset link to <strong>{email}</strong>.</p>
            <Link to="/login" className="mt-4 inline-flex items-center gap-1 text-sm font-medium hover:underline">
              <ArrowLeft className="h-3 w-3" /> Back to sign in
            </Link>
          </div>
        ) : (
          <>
            <p className="mt-1 text-sm text-muted-foreground">Enter your email and we'll send a reset link</p>
            <form onSubmit={handleReset} className="mt-6 space-y-4 text-left">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <Button type="submit" className="w-full bg-gradient-gold text-primary-foreground hover:opacity-90" disabled={loading}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Send Reset Link"}
              </Button>
            </form>
            <div className="mt-4">
              <Link to="/login" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                <ArrowLeft className="h-3 w-3" /> Back to sign in
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default ForgotPassword;
