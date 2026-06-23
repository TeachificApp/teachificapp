import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle, ChevronLeft, ChevronRight, Clock, Trophy } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { useLocation, useParams } from "wouter";

export default function QuizPlayerPage() {
  const [, setLocation] = useLocation();
  const params = useParams<{ id: string }>();
  const quizId = Number(params.id);

  const { data: quiz, isLoading } = trpc.quizzes.get.useQuery({ id: quizId });
  const startAttempt = trpc.quizzes.attempts.start.useMutation();
  const saveResponse = trpc.quizzes.attempts.saveResponse.useMutation();
  const submitAttempt = trpc.quizzes.attempts.submit.useMutation();
  const [attemptId, setAttemptId] = useState<number | null>(null);

  const [currentIdx, setCurrentIdx] = useState(0);
  const [answers, setAnswers] = useState<{ [qId: number]: number[] }>({});
  const [submitted, setSubmitted] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (quiz?.timeLimit && started) setTimeLeft(quiz.timeLimit * 60);
    if (started && quiz && !attemptId) {
      startAttempt.mutateAsync({ quizId }).then((r: any) => setAttemptId(r.insertId ?? r.id)).catch(() => {});
    }
  }, [quiz?.timeLimit, started]);

  useEffect(() => {
    if (timeLeft === null || timeLeft <= 0 || submitted) return;
    const t = setInterval(() => setTimeLeft((p) => (p ?? 1) - 1), 1000);
    return () => clearInterval(t);
  }, [timeLeft, submitted]);

  const handleSubmit = useCallback(async () => {
    if (!quiz) return;
    try {
      const aid = attemptId;
      if (aid) {
        // Save all responses first
        for (const [qId, choiceIds] of Object.entries(answers)) {
          await saveResponse.mutateAsync({ attemptId: aid, questionId: Number(qId), selectedChoiceIds: choiceIds as number[] });
        }
        const res = await submitAttempt.mutateAsync({ attemptId: aid });
        setResult({ passed: (res as any).passed, score: (res as any).score, correctCount: (res as any).correctCount, totalQuestions: (res as any).totalQuestions });
      } else {
        // Fallback: compute locally
        const qs = (quiz as any).questions ?? [];
        let correct = 0;
        for (const q of qs) {
          const sel = answers[q.id] ?? [];
          const correctIds = (q.choices ?? []).filter((c: any) => c.isCorrect).map((c: any) => c.id);
          if (sel.length === correctIds.length && correctIds.every((id: number) => sel.includes(id))) correct++;
        }
        const score = qs.length > 0 ? (correct / qs.length) * 100 : 0;
        setResult({ passed: score >= (quiz.passingScore ?? 70), score, correctCount: correct, totalQuestions: qs.length });
      }
      setSubmitted(true);
    } catch (err: any) { toast.error("Submit failed: " + err.message); }
  }, [quiz, answers, quizId, attemptId, saveResponse, submitAttempt]);

  useEffect(() => { if (timeLeft === 0 && !submitted) handleSubmit(); }, [timeLeft, submitted, handleSubmit]);

  if (isLoading) return <div className="flex items-center justify-center h-screen"><p className="text-muted-foreground">Loading quiz...</p></div>;
  if (!quiz) return <div className="flex items-center justify-center h-screen"><p className="text-muted-foreground">Quiz not found</p></div>;

  const questions = (quiz as any).questions ?? [];

  if (!started) return (
    <div className="flex items-center justify-center min-h-screen bg-background p-4">
      <Card className="w-full max-w-md shadow-lg">
        <CardContent className="p-8 text-center space-y-4">
          <div className="h-16 w-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto"><Trophy className="h-8 w-8 text-primary" /></div>
          <h1 className="text-2xl font-bold">{quiz.title}</h1>
          {quiz.description && <p className="text-muted-foreground text-sm">{quiz.description}</p>}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="p-3 rounded-lg bg-muted/50"><p className="text-muted-foreground text-xs">Questions</p><p className="font-bold text-lg">{questions.length}</p></div>
            <div className="p-3 rounded-lg bg-muted/50"><p className="text-muted-foreground text-xs">Passing</p><p className="font-bold text-lg">{quiz.passingScore ?? "—"}%</p></div>
            {quiz.timeLimit && <div className="p-3 rounded-lg bg-muted/50"><p className="text-muted-foreground text-xs">Time Limit</p><p className="font-bold text-lg">{quiz.timeLimit} min</p></div>}
          </div>
          <Button className="w-full" size="lg" onClick={() => setStarted(true)}>Start Quiz</Button>
          <Button variant="ghost" size="sm" onClick={() => setLocation("/quizzes")}>Back to Quizzes</Button>
        </CardContent>
      </Card>
    </div>
  );

  if (submitted && result) return (
    <div className="flex items-center justify-center min-h-screen bg-background p-4">
      <Card className="w-full max-w-md shadow-lg">
        <CardContent className="p-8 text-center space-y-5">
          <div className={`h-16 w-16 rounded-2xl flex items-center justify-center mx-auto ${result.passed ? "bg-emerald-100 text-emerald-600" : "bg-red-100 text-red-600"}`}>
            {result.passed ? <CheckCircle2 className="h-8 w-8" /> : <XCircle className="h-8 w-8" />}
          </div>
          <h2 className="text-2xl font-bold">{result.passed ? "Passed!" : "Not Passed"}</h2>
          <div className="p-5 rounded-xl bg-muted/50 space-y-3">
            <div className="flex justify-between text-sm"><span className="text-muted-foreground">Score</span><span className="font-bold text-xl">{result.score?.toFixed(1)}%</span></div>
            <Progress value={result.score ?? 0} className="h-3" />
            <div className="flex justify-between text-xs text-muted-foreground"><span>Correct: {result.correctCount}/{result.totalQuestions}</span><span>Passing: {quiz.passingScore ?? 0}%</span></div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => { setSubmitted(false); setAnswers({}); setCurrentIdx(0); setStarted(false); setAttemptId(null); setTimeLeft(null); setResult(null); }}>Retake</Button>
            <Button className="flex-1" onClick={() => setLocation("/quizzes")}>Done</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );

  const q = questions[currentIdx];
  if (!q) return null;
  const selected = answers[q.id] ?? [];
  const progress = ((currentIdx + 1) / questions.length) * 100;
  const toggleChoice = (cId: number) => {
    if (q.questionType === "multiple_choice" || q.questionType === "true_false") {
      setAnswers({ ...answers, [q.id]: [cId] });
    } else {
      const cur = answers[q.id] ?? [];
      setAnswers({ ...answers, [q.id]: cur.includes(cId) ? cur.filter((x: number) => x !== cId) : [...cur, cId] });
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <div className="border-b border-border bg-card px-4 py-3 flex items-center gap-3">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setLocation("/quizzes")}><ChevronLeft className="h-4 w-4" /></Button>
        <div className="flex-1"><p className="text-sm font-medium truncate">{quiz.title}</p><Progress value={progress} className="h-1.5 mt-1" /></div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-xs text-muted-foreground">{currentIdx + 1} / {questions.length}</span>
          {timeLeft !== null && <div className={`flex items-center gap-1 text-xs font-mono ${timeLeft < 60 ? "text-red-500" : "text-muted-foreground"}`}><Clock className="h-3.5 w-3.5" />{Math.floor(timeLeft / 60)}:{String(timeLeft % 60).padStart(2, "0")}</div>}
        </div>
      </div>
      <div className="flex-1 flex items-start justify-center p-4 pt-8">
        <div className="w-full max-w-2xl space-y-5">
          <div>
            <Badge variant="secondary" className="mb-2 text-xs">{(q.questionType ?? "").replace(/_/g, " ")}</Badge>
            <p className="text-lg font-medium leading-relaxed">{q.questionText}</p>
          </div>
          <div className="space-y-2.5">
            {(q.choices ?? []).map((c: any) => {
              const isSelected = selected.includes(c.id);
              return (
                <button key={c.id} onClick={() => toggleChoice(c.id)}
                  className={`w-full text-left p-4 rounded-xl border-2 transition-all text-sm ${isSelected ? "border-primary bg-primary/5" : "border-border hover:border-primary/40 hover:bg-accent/30"}`}>
                  <div className="flex items-center gap-3">
                    <div className={`h-5 w-5 rounded-full border-2 flex items-center justify-center shrink-0 ${isSelected ? "border-primary bg-primary" : "border-muted-foreground/40"}`}>
                      {isSelected && <div className="h-2.5 w-2.5 rounded-full bg-white" />}
                    </div>
                    {c.choiceText}
                  </div>
                </button>
              );
            })}
          </div>
          <div className="flex justify-between pt-2">
            <Button variant="outline" onClick={() => setCurrentIdx(Math.max(0, currentIdx - 1))} disabled={currentIdx === 0} className="gap-1.5"><ChevronLeft className="h-4 w-4" />Previous</Button>
            {currentIdx < questions.length - 1
              ? <Button onClick={() => setCurrentIdx(currentIdx + 1)} className="gap-1.5">Next<ChevronRight className="h-4 w-4" /></Button>
              : <Button onClick={handleSubmit} disabled={submitAttempt.isPending} className="gap-1.5 bg-emerald-600 hover:bg-emerald-700"><CheckCircle2 className="h-4 w-4" />{submitAttempt.isPending ? "Submitting..." : "Submit Quiz"}</Button>
            }
          </div>
        </div>
      </div>
    </div>
  );
}
