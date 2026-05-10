import { useState, useCallback } from "react";
import { useLocation, useSearch } from "wouter";
import { trpc } from "@/lib/trpc";
import { useOrgScope } from "@/hooks/useOrgScope";
import { usePlanLimits } from "@/hooks/usePlanLimits";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import UpgradePromptDialog from "@/components/UpgradePromptDialog";
import { useOrgPlan } from "@/hooks/useOrgPlan";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BarChart2, ChevronRight, Plus as PlusIcon, Trash2 as TrashIcon, Edit2 } from "lucide-react";
import {
  BookOpen,
  Plus,
  Search,
  MoreVertical,
  Edit,
  Trash2,
  Eye,
  Users,
  TrendingUp,
  GraduationCap,
  Sparkles,
  Loader2,
  Copy,
  Archive,
  Settings,
  GripVertical,
  CheckCircle2,
  Circle,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────
interface AiLesson {
  title: string;
  type: string;
  description: string;
}
interface AiModule {
  title: string;
  lessons: AiLesson[];
}
interface AiOutline {
  title: string;
  description: string;
  modules: AiModule[];
}
interface LandingPageData {
  heroHeadline: string;
  heroSubtitle: string;
  shortDescription: string;
  whatYouLearn: string[];
  requirements: string[];
  targetAudience: string;
  suggestedPriceFree: boolean;
  suggestedPrice: number;
}

// ─── Sortable course card wrapper ─────────────────────────────────────────────
function SortableCourseCard({ course, children }: { course: { id: number }; children: (dragHandleProps: React.HTMLAttributes<HTMLElement>) => React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: course.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };
  return (
    <div ref={setNodeRef} style={style}>
      {children({ ...attributes, ...listeners })}
    </div>
  );
}

// ─── Step indicator ───────────────────────────────────────────────────────────
function StepIndicator({ step, total }: { step: number; total: number }) {
  return (
    <div className="flex items-center gap-1 mb-4">
      {Array.from({ length: total }).map((_, i) => (
        <div key={i} className="flex items-center gap-1">
          <div className={`h-6 w-6 rounded-full flex items-center justify-center text-xs font-semibold transition-colors ${i + 1 <= step ? "bg-purple-600 text-white" : "bg-muted text-muted-foreground"}`}>
            {i + 1 < step ? <CheckCircle2 className="h-3.5 w-3.5" /> : i + 1}
          </div>
          {i < total - 1 && <div className={`h-0.5 w-6 transition-colors ${i + 1 < step ? "bg-purple-600" : "bg-muted"}`} />}
        </div>
      ))}
      <span className="ml-2 text-xs text-muted-foreground">Step {step} of {total}</span>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function CoursesPage() {
  const [, setLocation] = useLocation();
  const { orgId, ready } = useOrgScope();
  const utils = trpc.useUtils();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "draft" | "published" | "archived">("all");
  const [createOpen, setCreateOpen] = useState(false);
  const urlSearch = useSearch();
  // Auto-open create dialog when ?create=1 is in the URL
  const [autoOpened, setAutoOpened] = useState(false);
  if (!autoOpened && urlSearch.includes('create=1') && !createOpen) {
    setAutoOpened(true);
    setCreateOpen(true);
  }
  const [newTitle, setNewTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [localOrder, setLocalOrder] = useState<number[] | null>(null);
  const { can } = useOrgPlan(orgId ?? undefined);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  // ── AI Wizard state ──────────────────────────────────────────────────────
  const [aiOpen, setAiOpen] = useState(false);
  const [aiStep, setAiStep] = useState(1); // 1=topic, 2=outline, 3=landing, 4=confirm
  const [aiTopic, setAiTopic] = useState("");
  const [aiAudience, setAiAudience] = useState("");
  const [aiDifficulty, setAiDifficulty] = useState("Beginner");
  const [aiModules, setAiModules] = useState(3);
  const [aiLessons, setAiLessons] = useState(4);
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiOutline, setAiOutline] = useState<AiOutline | null>(null);
  const [aiLandingData, setAiLandingData] = useState<LandingPageData | null>(null);
  const [editingModule, setEditingModule] = useState<number | null>(null);
  const [editingLesson, setEditingLesson] = useState<{ moduleIdx: number; lessonIdx: number } | null>(null);

  const resetAiWizard = () => {
    setAiStep(1);
    setAiTopic("");
    setAiAudience("");
    setAiDifficulty("Beginner");
    setAiModules(3);
    setAiLessons(4);
    setAiOutline(null);
    setAiLandingData(null);
    setAiGenerating(false);
    setEditingModule(null);
    setEditingLesson(null);
  };

  // ── Mutations ────────────────────────────────────────────────────────────
  const reorderMutation = trpc.lms.courses.reorder.useMutation({
    onSuccess: () => utils.lms.courses.list.invalidate(),
    onError: () => {
      setLocalOrder(null);
      utils.lms.courses.list.invalidate();
    },
  });
  const { data: courses, isLoading } = trpc.lms.courses.list.useQuery(
    { orgId: orgId! },
    { enabled: ready }
  );
  const { canCreateCourse, plan, limits } = usePlanLimits();
  const atCourseLimit = !canCreateCourse(courses?.length ?? 0);

  const createMutation = trpc.lms.courses.create.useMutation({
    onSuccess: (course) => {
      utils.lms.courses.list.invalidate();
      setCreateOpen(false);
      setNewTitle("");
      toast.success("Course created");
      if (course?.id) setLocation(`/lms/courses/${course.id}/curriculum`);
    },
    onError: (e) => toast.error(e.message),
  });

  const aiGenerateOutlineMutation = trpc.lms.ai.generateCourse.useMutation({
    onSuccess: (outline) => {
      if (!outline?.title) { setAiGenerating(false); return; }
      setAiOutline(outline as AiOutline);
      setAiStep(2);
      setAiGenerating(false);
    },
    onError: (e) => { toast.error(e.message); setAiGenerating(false); },
  });

  const aiGenerateLandingMutation = trpc.lms.ai.generateLandingPage.useMutation({
    onSuccess: (data) => {
      setAiLandingData(data as LandingPageData);
      setAiStep(3);
      setAiGenerating(false);
    },
    onError: (e) => { toast.error(e.message); setAiGenerating(false); },
  });

  const aiCreateCourseMutation = trpc.lms.ai.createCourseFromOutline.useMutation({
    onSuccess: (course) => {
      utils.lms.courses.list.invalidate();
      toast.success(`Course "${course?.title}" created with all modules and lessons!`);
      setAiOpen(false);
      resetAiWizard();
      if (course?.id) setLocation(`/lms/courses/${course.id}/curriculum`);
    },
    onError: (e) => { toast.error(e.message); setAiGenerating(false); },
  });

  const copyMutation = trpc.lms.copy.course.useMutation({
    onSuccess: (course) => {
      utils.lms.courses.list.invalidate();
      toast.success("Course copied");
      if (course?.id) setLocation(`/lms/courses/${course.id}/curriculum`);
    },
    onError: (e) => toast.error(e.message),
  });

  const updateMutation = trpc.lms.courses.update.useMutation({
    onSuccess: () => {
      utils.lms.courses.list.invalidate();
      toast.success("Course updated");
    },
    onError: (e) => toast.error(e.message),
  });

  const deleteMutation = trpc.lms.courses.delete.useMutation({
    onSuccess: () => {
      utils.lms.courses.list.invalidate();
      toast.success("Course deleted");
    },
    onError: (e) => toast.error(e.message),
  });

  const handleCreate = async () => {
    if (!newTitle.trim() || !orgId) return;
    setCreating(true);
    try {
      await createMutation.mutateAsync({ orgId, title: newTitle.trim() });
    } finally {
      setCreating(false);
    }
  };

  // Derive ordered list: use localOrder for optimistic reordering
  const orderedCourses = localOrder && courses
    ? localOrder.map(id => courses.find(c => c.id === id)).filter(Boolean) as typeof courses
    : courses ?? [];

  const filtered = orderedCourses.filter((c) => {
    const matchesSearch = c.title.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === "all" || c.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !orgId) return;
    const currentOrder = localOrder ?? orderedCourses.map(c => c.id);
    const oldIndex = currentOrder.indexOf(active.id as number);
    const newIndex = currentOrder.indexOf(over.id as number);
    if (oldIndex === -1 || newIndex === -1) return;
    const newOrder = arrayMove(currentOrder, oldIndex, newIndex);
    setLocalOrder(newOrder);
    reorderMutation.mutate({ orgId, courseIds: newOrder });
  }, [localOrder, orderedCourses, orgId, reorderMutation]);

  const statusColor: Record<string, string> = {
    draft: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
    published: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
    archived: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
  };

  // ── AI wizard handlers ────────────────────────────────────────────────────
  const handleAiStep1 = () => {
    if (!aiTopic.trim() || !orgId) return;
    setAiGenerating(true);
    aiGenerateOutlineMutation.mutate({
      orgId,
      topic: aiTopic.trim(),
      numModules: aiModules,
      numLessonsPerModule: aiLessons,
    });
  };

  const handleAiStep2 = () => {
    if (!aiOutline) return;
    setAiGenerating(true);
    aiGenerateLandingMutation.mutate({
      topic: aiTopic.trim(),
      title: aiOutline.title,
      description: aiOutline.description,
      targetAudience: aiAudience || undefined,
      difficulty: aiDifficulty,
    });
  };

  const handleAiStep3 = () => {
    setAiStep(4);
  };

  const handleAiFinish = () => {
    if (!aiOutline || !orgId) return;
    setAiGenerating(true);
    aiCreateCourseMutation.mutate({
      orgId,
      title: aiOutline.title,
      description: aiOutline.description,
      shortDescription: aiLandingData?.shortDescription,
      whatYouLearn: aiLandingData?.whatYouLearn?.join("\n"),
      requirements: aiLandingData?.requirements?.join("\n"),
      targetAudience: aiLandingData?.targetAudience || aiAudience,
      modules: aiOutline.modules,
    });
  };

  const addModuleLesson = (moduleIdx: number) => {
    if (!aiOutline) return;
    const updated = { ...aiOutline };
    updated.modules = [...updated.modules];
    updated.modules[moduleIdx] = {
      ...updated.modules[moduleIdx],
      lessons: [...updated.modules[moduleIdx].lessons, { title: "New Lesson", type: "text", description: "" }],
    };
    setAiOutline(updated);
  };

  const removeLesson = (moduleIdx: number, lessonIdx: number) => {
    if (!aiOutline) return;
    const updated = { ...aiOutline };
    updated.modules = [...updated.modules];
    updated.modules[moduleIdx] = {
      ...updated.modules[moduleIdx],
      lessons: updated.modules[moduleIdx].lessons.filter((_, i) => i !== lessonIdx),
    };
    setAiOutline(updated);
  };

  const removeModule = (moduleIdx: number) => {
    if (!aiOutline) return;
    const updated = { ...aiOutline, modules: aiOutline.modules.filter((_, i) => i !== moduleIdx) };
    setAiOutline(updated);
  };

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Courses</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Create and manage your online courses
          </p>
        </div>
        <div className="flex items-center gap-2">

          <Button variant="outline" className="gap-2" onClick={() => setLocation(`/analytics/engagement?orgId=${orgId}`)}>
            <BarChart2 className="h-4 w-4" />
            <span className="hidden sm:inline">Reports</span>
          </Button>
          <Button
            variant="outline"
            className="gap-2"
            onClick={() => {
              if (!can("aiGeneration")) { setUpgradeOpen(true); return; }
              resetAiWizard();
              setAiOpen(true);
            }}
          >
            <Sparkles className="h-4 w-4 text-purple-500" />
            AI Generate
          </Button>
          <Button
            onClick={() => {
              if (atCourseLimit) {
                toast.error(`You've reached the ${limits?.maxCourses}-course limit on the ${plan} plan. Upgrade to add more courses.`);
                return;
              }
              setCreateOpen(true);
            }}
            className="gap-2"
            variant={atCourseLimit ? "outline" : "default"}
          >
            <Plus className="h-4 w-4" />
            New Course
            {atCourseLimit && <span className="ml-1 text-xs opacity-70">(Limit reached)</span>}
          </Button>
        </div>
      </div>

      {/* Stats row */}
      {courses && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card>
            <CardContent className="flex items-center gap-3 p-4">
              <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                <BookOpen className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="text-2xl font-bold">{courses.length}</p>
                <p className="text-xs text-muted-foreground">Total Courses</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3 p-4">
              <div className="h-10 w-10 rounded-lg bg-green-500/10 flex items-center justify-center">
                <TrendingUp className="h-5 w-5 text-green-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">
                  {courses.filter((c) => c.status === "published").length}
                </p>
                <p className="text-xs text-muted-foreground">Published</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3 p-4">
              <div className="h-10 w-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                <GraduationCap className="h-5 w-5 text-blue-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">
                  {courses.reduce((acc, c) => acc + (c.totalEnrollments ?? 0), 0)}
                </p>
                <p className="text-xs text-muted-foreground">Total Enrollments</p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search courses..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="published">Published</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Course grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-48 rounded-xl" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="h-16 w-16 rounded-full bg-muted flex items-center justify-center mb-4">
            <BookOpen className="h-8 w-8 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-semibold mb-1">No courses yet</h3>
          <p className="text-muted-foreground text-sm mb-6 max-w-sm">
            Create your first course manually or use AI to generate a full curriculum in seconds.
          </p>
          <div className="flex gap-3">
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => {
                if (!can("aiGeneration")) { setUpgradeOpen(true); return; }
                resetAiWizard();
                setAiOpen(true);
              }}
            >
              <Sparkles className="h-4 w-4 text-purple-500" />
              Generate with AI
            </Button>
            <Button onClick={() => setCreateOpen(true)} className="gap-2">
              <Plus className="h-4 w-4" />
              New Course
            </Button>
          </div>
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={filtered.map(c => c.id)} strategy={rectSortingStrategy}>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {filtered.map((course) => (
                <SortableCourseCard key={course.id} course={course}>
                  {(dragHandleProps) => (
                    <Card className="group hover:shadow-md transition-shadow cursor-pointer" onClick={() => setLocation(`/lms/courses/${course.id}/curriculum`)}>
                      {course.thumbnailUrl && (
                        <div className="aspect-video overflow-hidden rounded-t-xl">
                          <img src={course.thumbnailUrl} alt={course.title} className="w-full h-full object-cover" />
                        </div>
                      )}
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-center gap-2 flex-1 min-w-0">
                            <div
                              {...dragHandleProps}
                              className="opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing shrink-0"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <GripVertical className="h-4 w-4 text-muted-foreground" />
                            </div>
                            <h3 className="font-semibold text-sm truncate">{course.title}</h3>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <Badge className={`text-[10px] px-1.5 py-0 ${statusColor[course.status ?? "draft"] ?? statusColor.draft}`}>
                              {course.status ?? "draft"}
                            </Badge>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                                <Button variant="ghost" size="icon" className="h-7 w-7">
                                  <MoreVertical className="h-3.5 w-3.5" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                                <DropdownMenuItem onClick={() => setLocation(`/lms/courses/${course.id}/curriculum`)}>
                                  <Edit className="h-4 w-4 mr-2" />Edit
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => setLocation(`/lms/courses/${course.id}/settings`)}>
                                  <Settings className="h-4 w-4 mr-2" />Settings
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => setLocation(`/lms/courses/${course.id}/analytics`)}>
                                  <BarChart2 className="h-4 w-4 mr-2" />Analytics
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => window.open(`/learn/${course.id}`, "_blank")}>
                                  <Eye className="h-4 w-4 mr-2" />Preview
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => copyMutation.mutate({ courseId: course.id })}>
                                  <Copy className="h-4 w-4 mr-2" />Duplicate
                                </DropdownMenuItem>
                                {course.status !== "archived" && (
                                  <DropdownMenuItem onClick={() => updateMutation.mutate({ id: course.id, status: "archived" })}>
                                    <Archive className="h-4 w-4 mr-2" />Archive
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  className="text-destructive"
                                  onClick={() => {
                                    if (confirm(`Delete "${course.title}"?`)) {
                                      deleteMutation.mutate({ id: course.id });
                                    }
                                  }}
                                >
                                  <Trash2 className="h-4 w-4 mr-2" />
                                  Delete
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </div>

                          <div className="flex items-center gap-3 mt-3 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1">
                              <Users className="h-3 w-3" />
                              {course.totalEnrollments ?? 0} enrolled
                            </span>
                          </div>
                      </CardContent>
                    </Card>
                  )}
                </SortableCourseCard>
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {/* ── AI Course Generation Wizard ─────────────────────────────────────── */}
      <Dialog open={aiOpen} onOpenChange={(open) => { if (!open) resetAiWizard(); setAiOpen(open); }}>
        <DialogContent className={`${aiStep >= 2 ? "max-w-2xl sm:max-w-2xl h-[min(760px,calc(100dvh-2rem))]" : "max-w-lg max-h-[calc(100dvh-2rem)]"} grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden`}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-purple-500" />
              AI Course Generator
            </DialogTitle>
            <DialogDescription>
              {aiStep === 1 && "Describe your course and AI will generate a full curriculum."}
              {aiStep === 2 && "Review and edit the generated course outline."}
              {aiStep === 3 && "AI-generated landing page content for your course."}
              {aiStep === 4 && "Confirm and create your course with all modules and lessons."}
            </DialogDescription>
          </DialogHeader>

          <StepIndicator step={aiStep} total={4} />

          {/* Step 1: Topic & Settings */}
          {aiStep === 1 && (
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto py-1 pr-2">
              <div>
                <Label>Course Topic <span className="text-destructive">*</span></Label>
                <Textarea
                  placeholder="e.g. New Employee Onboarding Essentials"
                  value={aiTopic}
                  onChange={(e) => setAiTopic(e.target.value)}
                  className="mt-1.5 resize-none"
                  rows={2}
                  autoFocus
                />
              </div>
              <div>
                <Label>Target Audience</Label>
                <Input
                  placeholder="e.g. New managers, marketing professionals..."
                  value={aiAudience}
                  onChange={(e) => setAiAudience(e.target.value)}
                  className="mt-1.5"
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label>Difficulty</Label>
                  <Select value={aiDifficulty} onValueChange={setAiDifficulty}>
                    <SelectTrigger className="mt-1.5">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Beginner">Beginner</SelectItem>
                      <SelectItem value="Intermediate">Intermediate</SelectItem>
                      <SelectItem value="Advanced">Advanced</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Modules</Label>
                  <Input
                    type="number"
                    min={1}
                    max={10}
                    value={aiModules}
                    onChange={(e) => setAiModules(parseInt(e.target.value) || 3)}
                    className="mt-1.5"
                  />
                </div>
                <div>
                  <Label>Lessons/Module</Label>
                  <Input
                    type="number"
                    min={1}
                    max={10}
                    value={aiLessons}
                    onChange={(e) => setAiLessons(parseInt(e.target.value) || 4)}
                    className="mt-1.5"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Step 2: Review Outline */}
          {aiStep === 2 && aiOutline && (
            <div className="flex min-h-0 flex-col gap-3 overflow-y-auto py-1 pr-2">
              <div className="flex flex-col gap-1.5">
                <Label>Course Title</Label>
                <Input
                  value={aiOutline.title}
                  onChange={(e) => setAiOutline({ ...aiOutline, title: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Description</Label>
                <Textarea
                  value={aiOutline.description}
                  onChange={(e) => setAiOutline({ ...aiOutline, description: e.target.value })}
                  rows={2}
                  className="min-h-20 resize-none"
                />
              </div>
              <div className="flex flex-col gap-2 mt-1">
                <div className="flex items-center justify-between">
                  <Label>Modules & Lessons</Label>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs gap-1"
                    onClick={() => setAiOutline({ ...aiOutline, modules: [...aiOutline.modules, { title: "New Module", lessons: [] }] })}
                  >
                    <PlusIcon className="h-3.5 w-3.5" /> Add Module
                  </Button>
                </div>
                {aiOutline.modules.map((mod, mi) => (
                  <div key={mi} className="border border-border rounded-lg overflow-hidden">
                    <div className="flex items-start gap-2 px-3 py-2 bg-muted/40">
                      {editingModule === mi ? (
                        <Input
                          value={mod.title}
                          autoFocus
                          className="h-7 min-w-0 flex-1 text-sm"
                          onChange={(e) => {
                            const updated = { ...aiOutline };
                            updated.modules = [...updated.modules];
                            updated.modules[mi] = { ...updated.modules[mi], title: e.target.value };
                            setAiOutline(updated);
                          }}
                          onBlur={() => setEditingModule(null)}
                          onKeyDown={(e) => e.key === "Enter" && setEditingModule(null)}
                        />
                      ) : (
                        <span className="min-w-0 flex-1 break-words text-sm font-medium">{mod.title}</span>
                      )}
                      <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => setEditingModule(editingModule === mi ? null : mi)}>
                        <Edit2 className="h-3 w-3" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0 text-destructive hover:text-destructive" onClick={() => removeModule(mi)}>
                        <TrashIcon className="h-3 w-3" />
                      </Button>
                    </div>
                    <div className="divide-y divide-border">
                      {mod.lessons.map((les, li) => (
                        <div key={li} className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-sm">
                          <Circle className="h-3 w-3 text-muted-foreground shrink-0" />
                          {editingLesson?.moduleIdx === mi && editingLesson?.lessonIdx === li ? (
                            <Input
                              value={les.title}
                              autoFocus
                              className="h-6 min-w-0 flex-1 text-xs"
                              onChange={(e) => {
                                const updated = { ...aiOutline };
                                updated.modules = [...updated.modules];
                                updated.modules[mi] = { ...updated.modules[mi], lessons: [...updated.modules[mi].lessons] };
                                updated.modules[mi].lessons[li] = { ...les, title: e.target.value };
                                setAiOutline(updated);
                              }}
                              onBlur={() => setEditingLesson(null)}
                              onKeyDown={(e) => e.key === "Enter" && setEditingLesson(null)}
                            />
                          ) : (
                            <span className="min-w-0 flex-1 truncate">{les.title}</span>
                          )}
                          <Badge variant="outline" className="text-[10px] px-1 py-0 shrink-0">{les.type}</Badge>
                          <Button variant="ghost" size="icon" className="h-5 w-5 shrink-0" onClick={() => setEditingLesson({ moduleIdx: mi, lessonIdx: li })}>
                            <Edit2 className="h-2.5 w-2.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-5 w-5 shrink-0 text-destructive hover:text-destructive" onClick={() => removeLesson(mi, li)}>
                            <TrashIcon className="h-2.5 w-2.5" />
                          </Button>
                        </div>
                      ))}
                    </div>
                    <div className="px-3 py-1.5 border-t border-border">
                      <Button variant="ghost" size="sm" className="h-6 text-xs gap-1 text-muted-foreground" onClick={() => addModuleLesson(mi)}>
                        <PlusIcon className="h-3 w-3" /> Add Lesson
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Step 3: Landing Page Preview */}
          {aiStep === 3 && aiLandingData && (
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto py-1 pr-2">
              <div className="rounded-lg border border-border p-4 bg-muted/20 space-y-3">
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Hero Headline</p>
                  <Input
                    value={aiLandingData.heroHeadline}
                    onChange={(e) => setAiLandingData({ ...aiLandingData, heroHeadline: e.target.value })}
                    className="font-semibold"
                  />
                </div>
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Subtitle</p>
                  <Input
                    value={aiLandingData.heroSubtitle}
                    onChange={(e) => setAiLandingData({ ...aiLandingData, heroSubtitle: e.target.value })}
                  />
                </div>
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Short Description</p>
                  <Textarea
                    value={aiLandingData.shortDescription}
                    onChange={(e) => setAiLandingData({ ...aiLandingData, shortDescription: e.target.value })}
                    rows={2}
                    className="resize-none"
                  />
                </div>
              </div>
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">What You'll Learn</p>
                <div className="space-y-1.5">
                  {aiLandingData.whatYouLearn?.map((item, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                      <Input
                        value={item}
                        className="h-7 text-sm"
                        onChange={(e) => {
                          const updated = [...aiLandingData.whatYouLearn];
                          updated[i] = e.target.value;
                          setAiLandingData({ ...aiLandingData, whatYouLearn: updated });
                        }}
                      />
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <Label>Suggested Price</Label>
                  <Input
                    type="number"
                    min={0}
                    value={aiLandingData.suggestedPrice}
                    onChange={(e) => setAiLandingData({ ...aiLandingData, suggestedPrice: parseFloat(e.target.value) || 0, suggestedPriceFree: parseFloat(e.target.value) === 0 })}
                    className="w-24 h-8"
                  />
                  <span className="text-sm text-muted-foreground">USD</span>
                </div>
                {aiLandingData.suggestedPriceFree && <Badge variant="outline">Free</Badge>}
              </div>
            </div>
          )}

          {/* Step 4: Confirm */}
          {aiStep === 4 && aiOutline && (
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto py-1 pr-2">
              <div className="rounded-lg border border-border p-4 bg-muted/20 space-y-2">
                <p className="font-semibold">{aiOutline.title}</p>
                <p className="text-sm text-muted-foreground">{aiOutline.description}</p>
                <div className="flex items-center gap-4 text-sm text-muted-foreground mt-2">
                  <span className="flex items-center gap-1">
                    <BookOpen className="h-3.5 w-3.5" />
                    {aiOutline.modules.length} modules
                  </span>
                  <span className="flex items-center gap-1">
                    <GraduationCap className="h-3.5 w-3.5" />
                    {aiOutline.modules.reduce((acc, m) => acc + m.lessons.length, 0)} lessons
                  </span>
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                Clicking <strong>Create Course</strong> will create the course with all modules and lessons in your curriculum builder. You can add content to each lesson afterwards.
              </p>
            </div>
          )}

          <DialogFooter className="gap-2">
            {aiStep > 1 && (
              <Button variant="outline" onClick={() => setAiStep(aiStep - 1)} disabled={aiGenerating}>
                Back
              </Button>
            )}
            <Button variant="outline" onClick={() => { setAiOpen(false); resetAiWizard(); }} disabled={aiGenerating}>
              Cancel
            </Button>
            {aiStep === 1 && (
              <Button disabled={!aiTopic.trim() || aiGenerating || !orgId} onClick={handleAiStep1} className="gap-2 bg-purple-600 hover:bg-purple-700">
                {aiGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {aiGenerating ? "Generating Outline..." : "Generate Outline"}
              </Button>
            )}
            {aiStep === 2 && (
              <Button disabled={aiGenerating} onClick={handleAiStep2} className="gap-2 bg-purple-600 hover:bg-purple-700">
                {aiGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {aiGenerating ? "Generating Landing Page..." : "Generate Landing Page"}
              </Button>
            )}
            {aiStep === 3 && (
              <Button onClick={handleAiStep3} className="gap-2">
                <ChevronRight className="h-4 w-4" />
                Review & Confirm
              </Button>
            )}
            {aiStep === 4 && (
              <Button disabled={aiGenerating} onClick={handleAiFinish} className="gap-2 bg-purple-600 hover:bg-purple-700">
                {aiGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                {aiGenerating ? "Creating Course..." : "Create Course"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Upgrade Prompt */}
      <UpgradePromptDialog
        open={upgradeOpen}
        onClose={() => setUpgradeOpen(false)}
        requiredPlan="starter"
        featureName="AI Course Generation"
        featureDescription="Automatically generate a full course outline with modules and lessons from a single topic using AI."
      />

      {/* Create Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New Course</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <Label htmlFor="course-title">Course Title</Label>
            <Input
              id="course-title"
              placeholder="e.g. Leadership Skills for New Managers"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              className="mt-1.5"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={!newTitle.trim() || creating}>
              {creating ? "Creating..." : "Create Course"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
