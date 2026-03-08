import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Mic, ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";

const Signup = () => {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 6) {
      toast.error("Password must be at least 6 characters");
      return;
    }
    setLoading(true);

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: window.location.origin,
        data: { display_name: displayName },
      },
    });

    if (error) {
      toast.error(error.message);
    } else {
      toast.success("Check your email to confirm your account!");
      navigate("/login");
    }
    setLoading(false);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <Link to="/" className="mb-6 inline-flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-gold">
              <Mic className="h-5 w-5 text-foreground" />
            </div>
            <span className="font-display text-xl font-bold tracking-tight">Somali Voice Bridge</span>
          </Link>
          <h1 className="mt-4 font-display text-2xl font-bold">Create your account</h1>
          <p className="mt-1 text-sm text-muted-foreground">Start transcribing Somali audio today</p>
        </div>

        <form onSubmit={handleSignup} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Display Name</Label>
            <Input id="name" placeholder="Your name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" placeholder="Min 6 characters" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <Button type="submit" className="w-full bg-gradient-gold text-primary-foreground hover:opacity-90" disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create Account"}
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link to="/login" className="font-medium text-foreground hover:underline">Sign in</Link>
        </p>
        <div className="mt-4 text-center">
          <Link to="/" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-3 w-3" /> Back to home
          </Link>
        </div>
      </div>
    </div>
  );
};

export default Signup;
