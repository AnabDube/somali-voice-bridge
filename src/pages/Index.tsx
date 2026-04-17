import { Link } from "react-router-dom";
import { ArrowRight, Mic, Languages, Shield, Zap, Upload, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import Navbar from "@/components/Navbar";
import { motion } from "framer-motion";

const features = [
  {
    icon: Mic,
    title: "Somali Speech Recognition",
    description: "Upload or record Somali audio and get accurate transcriptions powered by advanced AI models.",
  },
  {
    icon: Languages,
    title: "Instant Translation",
    description: "Somali text is automatically translated into clear, natural English in real time.",
  },
  {
    icon: Zap,
    title: "Fast Processing",
    description: "Get results in seconds, not minutes. Optimized for speed without sacrificing accuracy.",
  },
  {
    icon: Shield,
    title: "Private & Secure",
    description: "Your audio is encrypted and you control your data. Delete recordings anytime.",
  },
];

const steps = [
  {
    icon: Upload,
    title: "Upload or record",
    description: "Drop in a Somali audio file or record directly from your browser.",
  },
  {
    icon: FileText,
    title: "Get your transcript",
    description: "AI transcribes the audio into Somali text with timestamps in seconds.",
  },
  {
    icon: Languages,
    title: "Translate to English",
    description: "Click translate to get a natural English version of the transcript.",
  },
];

const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.1, duration: 0.5, ease: "easeOut" as const },
  }),
};

const Index = () => {
  return (
    <div className="min-h-screen bg-background">
      <Navbar />

      {/* Hero */}
      <section className="container mx-auto px-4 pb-20 pt-32 text-center lg:pt-40">
        <motion.div initial="hidden" animate="visible" variants={fadeUp} custom={0}>
          <div className="mx-auto mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-1.5 text-sm shadow-card">
            <span className="h-2 w-2 rounded-full bg-gradient-gold" />
            Bridging Somali voices to the world
          </div>
        </motion.div>

        <motion.h1
          className="mx-auto max-w-3xl font-display text-4xl font-bold leading-tight tracking-tight sm:text-5xl lg:text-6xl"
          initial="hidden"
          animate="visible"
          variants={fadeUp}
          custom={1}
        >
          Transcribe & Translate{" "}
          <span className="text-gradient-gold">Somali Audio</span>{" "}
          Instantly
        </motion.h1>

        <motion.p
          className="mx-auto mt-5 max-w-xl text-lg text-muted-foreground"
          initial="hidden"
          animate="visible"
          variants={fadeUp}
          custom={2}
        >
          Upload or record Somali speech and get accurate transcriptions with English translations — powered by AI that understands Somali dialects.
        </motion.p>

        <motion.div
          className="mt-8 flex flex-wrap items-center justify-center gap-3"
          initial="hidden"
          animate="visible"
          variants={fadeUp}
          custom={3}
        >
          <Button size="lg" className="gap-2 bg-gradient-gold text-primary-foreground hover:opacity-90" asChild>
            <Link to="/dashboard">
              Start Transcribing <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <Button size="lg" variant="outline" asChild>
            <Link to="/pricing">View Pricing</Link>
          </Button>
        </motion.div>
      </section>

      {/* How it works */}
      <section className="container mx-auto px-4 pb-20">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
            How it works
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Three steps from audio to translated text.
          </p>
        </div>

        <div className="mt-10 grid gap-6 sm:grid-cols-3">
          {steps.map((s, i) => (
            <motion.div
              key={s.title}
              className="relative rounded-xl border border-border bg-card p-6 shadow-card"
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true }}
              variants={fadeUp}
              custom={i}
            >
              <div className="absolute -top-3 left-6 flex h-7 w-7 items-center justify-center rounded-full bg-gradient-gold text-xs font-bold text-primary-foreground shadow-card">
                {i + 1}
              </div>
              <div className="mb-3 mt-2 flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                <s.icon className="h-5 w-5 text-muted-foreground" />
              </div>
              <h3 className="font-display text-base font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {s.description}
              </p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="container mx-auto px-4 pb-24">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {features.map((f, i) => (
            <motion.div
              key={f.title}
              className="rounded-xl border border-border bg-card p-6 shadow-card transition-shadow hover:shadow-elevated"
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true }}
              variants={fadeUp}
              custom={i}
            >
              <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                <f.icon className="h-5 w-5 text-muted-foreground" />
              </div>
              <h3 className="font-display text-base font-semibold">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{f.description}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border py-8">
        <div className="container mx-auto flex flex-col items-center gap-2 px-4 text-center text-sm text-muted-foreground">
          <p>&copy; {new Date().getFullYear()} Somali Voice Bridge. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
};

export default Index;
