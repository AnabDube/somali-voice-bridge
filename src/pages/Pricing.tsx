import { Check, Zap, Building2, Star, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import Navbar from "@/components/Navbar";
import { useAuth } from "@/contexts/AuthContext";
import { useProfile } from "@/hooks/useProfile";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const plans = [
  {
    id: "free" as const,
    name: "Free",
    price: "$0",
    period: "forever",
    minutes: 30,
    icon: Zap,
    features: [
      "30 minutes/month",
      "Somali transcription",
      "English translation",
      "TXT & PDF export",
      "Copy to clipboard",
    ],
    cta: "Current Plan",
    popular: false,
  },
  {
    id: "starter" as const,
    name: "Starter",
    price: "$5",
    period: "/month",
    minutes: 120,
    icon: Rocket,
    features: [
      "120 minutes/month",
      "Everything in Free",
      "Faster processing",
      "Upload history",
      "Email support",
    ],
    cta: "Upgrade to Starter",
    popular: false,
  },
  {
    id: "professional" as const,
    name: "Pro",
    price: "$10",
    period: "/month",
    minutes: 300,
    icon: Star,
    features: [
      "300 minutes/month",
      "Everything in Starter",
      "Priority processing",
      "Speaker timestamps",
      "Priority support",
    ],
    cta: "Upgrade to Pro",
    popular: true,
  },
  {
    id: "business" as const,
    name: "Business",
    price: "Custom",
    period: "",
    minutes: 0,
    icon: Building2,
    features: [
      "Unlimited minutes",
      "Everything in Pro",
      "Custom integrations",
      "Dedicated support",
      "SLA guarantee",
    ],
    cta: "Contact Sales",
    popular: false,
  },
];

const Pricing = () => {
  const { user } = useAuth();
  const { profile } = useProfile();
  const currentPlan = profile?.subscription_plan ?? "free";

  const handleUpgrade = (planId: string) => {
    if (planId === "business") {
      toast.info("Please contact us at support@somalivoicebridge.com for Business plans.");
      return;
    }
    toast.info("Payment integration coming soon. Contact support to upgrade your plan.");
  };

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <main className="container mx-auto px-4 pb-16 pt-24">
        <div className="mx-auto max-w-4xl text-center">
          <h1 className="font-display text-4xl font-bold tracking-tight text-foreground">
            Simple, transparent pricing
          </h1>
          <p className="mt-3 text-lg text-muted-foreground">
            Choose the plan that fits your transcription needs
          </p>
        </div>

        <div className="mx-auto mt-12 grid max-w-6xl gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {plans.map((plan) => {
            const isCurrent = currentPlan === plan.id;
            return (
              <div
                key={plan.id}
                className={cn(
                  "relative flex flex-col rounded-2xl border p-6 shadow-card transition-shadow hover:shadow-lg",
                  plan.popular
                    ? "border-primary bg-primary/5 ring-2 ring-primary/20"
                    : "border-border bg-card"
                )}
              >
                {plan.popular && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-primary px-4 py-1 text-xs font-semibold text-primary-foreground">
                    Most Popular
                  </span>
                )}

                <div className="mb-6">
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-muted">
                    <plan.icon className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <h3 className="mt-4 font-display text-xl font-bold text-foreground">
                    {plan.name}
                  </h3>
                  <div className="mt-2 flex items-baseline gap-1">
                    <span className="font-display text-4xl font-bold text-foreground">
                      {plan.price}
                    </span>
                    {plan.period && (
                      <span className="text-sm text-muted-foreground">{plan.period}</span>
                    )}
                  </div>
                </div>

                <ul className="mb-8 flex-1 space-y-3">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-center gap-2 text-sm text-foreground">
                      <Check className="h-4 w-4 shrink-0 text-secondary" />
                      {f}
                    </li>
                  ))}
                </ul>

                <Button
                  className={cn(
                    "w-full",
                    plan.popular && !isCurrent
                      ? "bg-gradient-gold text-primary-foreground hover:opacity-90"
                      : ""
                  )}
                  variant={isCurrent ? "outline" : plan.popular ? "default" : "secondary"}
                  disabled={isCurrent}
                  onClick={() => handleUpgrade(plan.id)}
                >
                  {isCurrent ? "Current Plan" : plan.cta}
                </Button>
              </div>
            );
          })}
        </div>

        <p className="mt-10 text-center text-sm text-muted-foreground">
          Need a custom plan? Contact us at{" "}
          <a href="mailto:support@somalivoicebridge.com" className="text-primary underline">
            support@somalivoicebridge.com
          </a>
        </p>
      </main>
    </div>
  );
};

export default Pricing;
