import { motion } from "framer-motion";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";

const ERRORS = [
  { title: "We can't find what you're looking for", subtitle: "Like smoke in the wind, it's gone." },
  { title: "No droids here", subtitle: "These aren't the files you're looking for." },
  { title: "There is no cake", subtitle: "The promise was real. The data was not." },
  { title: "This share has evaporated", subtitle: "Poof. Into the digital ether." },
  { title: "Signal lost", subtitle: "This message, if it ever existed, has self-destructed." },
];

const error = ERRORS[Math.floor(Math.random() * ERRORS.length)];

export default function NotFound() {
  const [, navigate] = useLocation();

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-center space-y-6 max-w-md"
      >
        <div className="text-6xl" role="img" aria-label="Dog mascot">🐕</div>
        <div className="space-y-2">
          <div className="font-mono text-xs text-muted-foreground uppercase tracking-widest">404</div>
          <div className="font-mono font-bold text-xl">{error.title}</div>
          <div className="text-muted-foreground font-mono text-sm">{error.subtitle}</div>
        </div>
        <Button
          variant="outline"
          onClick={() => navigate("/")}
          className="font-mono"
          aria-label="Go to home page"
        >
          Go Home
        </Button>
      </motion.div>
    </div>
  );
}
