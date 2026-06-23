import { useState, useEffect } from "react";
import { LessonEditorSheet } from "@/components/lms/LessonEditorSheet";
import CourseOverviewTab from "@/components/lms/CourseOverviewTab";
import { useParams, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { getOrgCoursePlayerUrl, getOrgCourseUrl, getOrgThankYouUrl } from "@/lib/orgUrl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useOrgPlan } from "@/hooks/useOrgPlan";
import UpgradePromptDialog from "@/components/UpgradePromptDialog";
import { toast } from "sonner";
import {
  ChevronLeft,
  Plus,
  GripVertical,
  MoreVertical,
  Edit,
  Trash2,
  Video,
  FileText,
  HelpCircle,
  FileArchive,
  Music,
  Download,
  ChevronDown,
  ChevronRight,
  Eye,
  Settings,
  DollarSign,
  Calendar,
  CheckCircle,
  Copy,
  ExternalLink,
  LayoutList,
  Users,
  BookOpen,
  Mail,
  Clock,
  Lock,
  Unlock,
  Globe,
} from "lucide-react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

const LESSON_TYPES = [
  { value: "video", label: "Video", icon: Video },
  { value: "text", label: "Text / Rich Content", icon: FileText },
  { value: "scorm", label: "SCORM / HTML5", icon: FileArchive },
  { value: "quiz", label: "Quiz", icon: HelpCircle },
  { value: "flashcard", label: "Flashcards", icon: FileText },
  { value: "exam", label: "Exam", icon: CheckCircle },
  { value: "pdf", label: "PDF", icon: FileText },
  { value: "audio", label: "Audio", icon: Music },
  { value: "assignment", label: "Assignment", icon: Edit },
  { value: "download", label: "Download", icon: Download },
  { value: "weblink", label: "Web Link / Embed", icon: Eye },
  { value: "zoom", label: "Zoom / Live Session", icon: Video },
];

const lessonTypeIcon = (type: string) => {
  const found = LESSON_TYPES.find((t) => t.value === type);
  const Icon = found?.icon ?? FileText;
  return <Icon className="h-3.5 w-3.5" />;
};

// ─── Sortable Lesson Item ────────────────────────────────────────────────────

function SortableLesson({
  lesson,
  onEdit,
  onDelete,
}: {
  lesson: { id: number; title: string; lessonType: string; isFreePreview: boolean; isPublished: boolean; durationSeconds?: number | null };
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: lesson.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const formatDuration = (secs?: number | null) => {
    if (!secs) return null;
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      onClick={onEdit}
      className="flex items-center gap-2 px-3 py-2.5 bg-background border border-border/50 rounded-lg hover:border-border hover:bg-muted/30 transition-colors group cursor-pointer"
    >
      <button
        {...attributes}
        {...listeners}
        onClick={(e) => e.stopPropagation()}
        className="cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-muted-foreground transition-colors"
      >
        <GripVertical className="h-4 w-4" />
      </button>

      <span className="text-muted-foreground">{lessonTypeIcon(lesson.lessonType)}</span>

      <span className="flex-1 text-sm truncate">{lesson.title}</span>

      <div className="flex items-center gap-2 shrink-0">
        {lesson.isFreePreview && (
          <Badge variant="outline" className="text-xs h-5 px-1.5 text-primary border-primary/30">
            Free Preview
          </Badge>
        )}
        {formatDuration(lesson.durationSeconds) && (
          <span className="text-xs text-muted-foreground">
            {formatDuration(lesson.durationSeconds)}
          </span>
        )}
        {lesson.isPublished ? (
          <CheckCircle className="h-3.5 w-3.5 text-green-500" />
        ) : (
          <span className="h-3.5 w-3.5 rounded-full border-2 border-muted-foreground/30" />
        )}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={(e) => e.stopPropagation()}
            className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <MoreVertical className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onEdit}>
            <Edit className="h-4 w-4 mr-2" /> Edit
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={onDelete}
          >
            <Trash2 className="h-4 w-4 mr-2" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ─── Section Block ────────────────────────────────────────────────────────────

function SectionBlock({
  section,
  courseId,
  onRefresh,
  onEditLesson,
}: {
  section: {
    id: number;
    title: string;
    isFreePreview: boolean;
    lessons: Array<{ id: number; title: string; lessonType: string; isFreePreview: boolean; isPublished: boolean; durationSeconds?: number | null; sortOrder: number }>;
  };
  courseId: number;
  onRefresh: () => void;
  onEditLesson?: (lessonId: number) => void;
}) {
  const utils = trpc.useUtils();
  const [expanded, setExpanded] = useState(true);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleVal, setTitleVal] = useState(section.title);
  const [addLessonOpen, setAddLessonOpen] = useState(false);
  const [newLessonTitle, setNewLessonTitle] = useState("");
  const [newLessonType, setNewLessonType] = useState("video");
  const [lessonIds, setLessonIds] = useState(
    [...section.lessons].sort((a, b) => a.sortOrder - b.sortOrder).map((l) => l.id)
  );

  useEffect(() => {
    setLessonIds([...section.lessons].sort((a, b) => a.sortOrder - b.sortOrder).map((l) => l.id));
  }, [section.lessons]);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const updateSection = trpc.lms.curriculum.updateSection.useMutation({
    onSuccess: onRefresh,
  });
  const deleteSection = trpc.lms.curriculum.deleteSection.useMutation({
    onSuccess: () => {
      onRefresh();
      toast.success("Section deleted");
    },
  });
  const createLesson = trpc.lms.curriculum.createLesson.useMutation({
    onSuccess: (data) => {
      onRefresh();
      setAddLessonOpen(false);
      setNewLessonTitle("");
      toast.success("Lesson added");
      // Auto-open the editor for the newly created lesson
      if (data?.id && onEditLesson) {
        onEditLesson(data.id);
      }
    },
    onError: (e) => toast.error(e.message),
  });
  const deleteLesson = trpc.lms.curriculum.deleteLesson.useMutation({
    onSuccess: () => {
      onRefresh();
      toast.success("Lesson deleted");
    },
  });
  const reorderLessons = trpc.lms.curriculum.reorderLessons.useMutation();

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = lessonIds.indexOf(active.id as number);
    const newIdx = lessonIds.indexOf(over.id as number);
    const reordered = arrayMove(lessonIds, oldIdx, newIdx);
    setLessonIds(reordered);
    reorderLessons.mutate({ lessonIds: reordered });
  };

  const handleTitleBlur = () => {
    setEditingTitle(false);
    if (titleVal !== section.title) {
      updateSection.mutate({ id: section.id, title: titleVal });
    }
  };

  const sortedLessons = lessonIds
    .map((id) => section.lessons.find((l) => l.id === id))
    .filter(Boolean) as typeof section.lessons;

  return (
    <div className="border border-border rounded-xl overflow-hidden p-4 sm:p-6 max-w-7xl mx-auto">
      {/* Section header */}
      <div className="flex items-center gap-2 px-4 py-3 bg-muted/30">
        <button onClick={() => setExpanded((v) => !v)} className="text-muted-foreground">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>

        {editingTitle ? (
          <Input
            value={titleVal}
            onChange={(e) => setTitleVal(e.target.value)}
            onBlur={handleTitleBlur}
            onKeyDown={(e) => e.key === "Enter" && handleTitleBlur()}
            className="h-7 text-sm font-semibold flex-1"
            autoFocus
          />
        ) : (
          <button
            className="flex-1 text-left text-sm font-semibold hover:text-primary transition-colors"
            onClick={() => setEditingTitle(true)}
          >
            {section.title}
          </button>
        )}

        <span className="text-xs text-muted-foreground">
          {section.lessons.length} lesson{section.lessons.length !== 1 ? "s" : ""}
        </span>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7">
              <MoreVertical className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setEditingTitle(true)}>
              <Edit className="h-4 w-4 mr-2" /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => {
                if (confirm("Delete this section and all its lessons?")) {
                  deleteSection.mutate({ id: section.id });
                }
              }}
            >
              <Trash2 className="h-4 w-4 mr-2" /> Delete Section
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Lessons */}
      {expanded && (
        <div className="p-3 flex flex-col gap-2">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={lessonIds} strategy={verticalListSortingStrategy}>
              {sortedLessons.map((lesson) => (
                <SortableLesson
                  key={lesson.id}
                  lesson={lesson}
                  onEdit={() => onEditLesson?.(lesson.id)}
                  onDelete={() => {
                    if (confirm(`Delete "${lesson.title}"?`)) {
                      deleteLesson.mutate({ id: lesson.id });
                    }
                  }}
                />
              ))}
            </SortableContext>
          </DndContext>

          <Button
            variant="ghost"
            size="sm"
            className="justify-start gap-2 text-muted-foreground hover:text-foreground mt-1"
            onClick={() => setAddLessonOpen(true)}
          >
            <Plus className="h-4 w-4" />
            Add Lesson
          </Button>
        </div>
      )}

      {/* Add Lesson Dialog */}
      <Dialog open={addLessonOpen} onOpenChange={setAddLessonOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Lesson</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <div>
              <Label>Lesson Title</Label>
              <Input
                placeholder="e.g. Introduction to Doppler"
                value={newLessonTitle}
                onChange={(e) => setNewLessonTitle(e.target.value)}
                className="mt-1.5"
                autoFocus
              />
            </div>
            <div>
              <Label>Lesson Type</Label>
              <Select value={newLessonType} onValueChange={setNewLessonType}>
                <SelectTrigger className="mt-1.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LESSON_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      <div className="flex items-center gap-2">
                        <t.icon className="h-4 w-4" />
                        {t.label}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddLessonOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!newLessonTitle.trim()}
              onClick={() =>
                createLesson.mutate({
                  courseId,
                  sectionId: section.id,
                  title: newLessonTitle.trim(),
                  lessonType: newLessonType as any,
                  sortOrder: section.lessons.length,
                })
              }
            >
              Add Lesson
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function CourseBuilderPage() {
  const { id } = useParams<{ id: string }>();
  const courseId = parseInt(id ?? "0");
  const [location, setLocation] = useLocation();
  const utils = trpc.useUtils();
  // Derive active tab from URL sub-path (e.g. /lms/courses/5/curriculum → "curriculum")
  type TabId = "overview" | "curriculum" | "settings" | "pricing" | "sales_page" | "after_purchase" | "drip";
  const tabFromUrl = ((): TabId => {
    const seg = location.split("/").pop() ?? "";
    if (["overview", "curriculum", "settings", "pricing", "sales_page", "after_purchase", "drip"].includes(seg))
      return seg as TabId;
    return "curriculum";
  })();
  const [activeTab, setActiveTab] = useState<TabId>(tabFromUrl);
  const [addSectionOpen, setAddSectionOpen] = useState(false);
  const [newSectionTitle, setNewSectionTitle] = useState("");
  const [editingLessonId, setEditingLessonId] = useState<number | null>(null);
  const [lessonEditorOpen, setLessonEditorOpen] = useState(false);
  const { data: orgs } = trpc.orgs.myOrgs.useQuery();
  const orgId = orgs?.[0]?.id ?? 0;
  const { data: editingLesson } = trpc.lms.curriculum.getLesson.useQuery(
    { id: editingLessonId! },
    { enabled: !!editingLessonId }
  );
  const openLessonEditor = (lessonId: number) => {
    setEditingLessonId(lessonId);
    setLessonEditorOpen(true);
  };

  const { data: course, isLoading: courseLoading } = trpc.lms.courses.get.useQuery(
    { id: courseId },
    { enabled: !!courseId }
  );
  const { data: curriculum, isLoading: curriculumLoading, refetch } = trpc.lms.curriculum.get.useQuery(
    { courseId },
    { enabled: !!courseId }
  );

  const createSection = trpc.lms.curriculum.createSection.useMutation({
    onSuccess: () => {
      refetch();
      setAddSectionOpen(false);
      setNewSectionTitle("");
      toast.success("Section added");
    },
    onError: (e) => toast.error(e.message),
  });

  const updateCourse = trpc.lms.courses.update.useMutation({
    onSuccess: () => {
      utils.lms.courses.get.invalidate({ id: courseId });
      toast.success("Saved");
    },
    onError: (e) => toast.error(e.message),
  });

  const tabs = [
    { id: "overview", label: "Overview", icon: LayoutList },
    { id: "curriculum", label: "Curriculum", icon: FileText },
    { id: "settings", label: "Settings", icon: Settings },
    { id: "pricing", label: "Pricing", icon: DollarSign },
    { id: "sales_page", label: "Sales Page", icon: Globe },
    { id: "after_purchase", label: "After Purchase", icon: CheckCircle },
    { id: "drip", label: "Drip Schedule", icon: Calendar },
  ] as const;

  if (courseLoading) {
    return (
      <div className="p-6 flex flex-col gap-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!course) {
    return (
      <div className="p-6 text-center text-muted-foreground">Course not found</div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-background sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setLocation("/lms/courses")}
            className="h-8 w-8"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold leading-tight">{course.title}</h1>
              <Badge
                variant="outline"
                className={
                  course.status === "published" ? "text-green-600 border-green-300 bg-green-50 dark:bg-green-900/20" :
                  course.status === "hidden" ? "text-blue-600 border-blue-300 bg-blue-50 dark:bg-blue-900/20" :
                  course.status === "private" ? "text-purple-600 border-purple-300 bg-purple-50 dark:bg-purple-900/20" :
                  course.status === "archived" ? "text-gray-600 border-gray-300 bg-gray-50 dark:bg-gray-900/20" :
                  "text-yellow-600 border-yellow-300 bg-yellow-50 dark:bg-yellow-900/20"
                }
              >
                {course.status.charAt(0).toUpperCase() + course.status.slice(1)}
              </Badge>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => {
              const org = orgs?.[0];
              const url = org
                ? `${getOrgCoursePlayerUrl(org.slug, courseId, org.customDomain, org.domainVerificationStatus)}?preview=1`
                : `/learn/${courseId}?preview=1`;
              window.open(url, "_blank");
            }}
          >
            <Eye className="h-3.5 w-3.5" />
            Preview as Student
          </Button>
          <select
            className="h-8 px-2 text-sm border rounded-md bg-background"
            value={course.status}
            onChange={(e) => updateCourse.mutate({ id: courseId, status: e.target.value as any })}
          >
            <option value="draft">Draft</option>
            <option value="published">Published</option>
            <option value="hidden">Hidden (URL only)</option>
            <option value="private">Private (Invite only)</option>
            <option value="archived">Archived</option>
          </select>
        </div>
      </div>

      {/* Tab bar — scrollable on mobile */}
      <div className="flex items-center gap-0 px-2 sm:px-6 border-b border-border bg-background overflow-x-auto scrollbar-none">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 px-3 sm:px-4 py-3 text-xs sm:text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${
              activeTab === tab.id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <tab.icon className="h-3.5 w-3.5" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        {activeTab === "overview" && (
          <CourseOverviewTab
            course={course}
            onSave={(data) => updateCourse.mutate({ id: courseId, ...data })}
          />
        )}
        {activeTab === "curriculum" && (
          <div className="max-w-3xl mx-auto flex flex-col gap-4">
            {curriculumLoading ? (
              [...Array(3)].map((_, i) => <Skeleton key={i} className="h-24 w-full rounded-xl" />)
            ) : curriculum?.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-4 text-center border-2 border-dashed border-border rounded-xl">
                <FileText className="h-10 w-10 text-muted-foreground/40" />
                <div>
                  <p className="font-medium">No sections yet</p>
                  <p className="text-sm text-muted-foreground">
                    Add a section to start building your curriculum
                  </p>
                </div>
                <Button onClick={() => setAddSectionOpen(true)} className="gap-2">
                  <Plus className="h-4 w-4" />
                  Add Section
                </Button>
              </div>
            ) : (
              <>
                {curriculum?.map((section) => (
                  <SectionBlock
                    key={section.id}
                    section={section as any}
                    courseId={courseId}
                    onRefresh={refetch}
                    onEditLesson={openLessonEditor}
                  />
                ))}
                <Button
                  variant="outline"
                  className="gap-2 self-start"
                  onClick={() => setAddSectionOpen(true)}
                >
                  <Plus className="h-4 w-4" />
                  Add Section
                </Button>
              </>
            )}
          </div>
        )}

        {activeTab === "settings" && (
          <CourseSettingsTab course={course} onSave={(data) => updateCourse.mutate({ id: courseId, ...data })} />
        )}

        {activeTab === "pricing" && (
          <CoursePricingTab courseId={courseId} />
        )}

        {activeTab === "sales_page" && (
          <div className="max-w-3xl mx-auto">
            <div className="border border-border rounded-xl p-6 space-y-4">
              <div>
                <h3 className="text-lg font-semibold">Course Sales Page</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Design a custom landing page for your course. This page is shown to visitors before they enroll.
                </p>
              </div>
              <div className="flex items-center gap-3">
                <Button
                  className="gap-2"
                  onClick={() => setLocation(`/lms/courses/${courseId}/page-builder`)}
                >
                  <Edit className="h-4 w-4" />
                  Open Sales Page Builder
                </Button>
                <Button
                  variant="outline"
                  className="gap-2"
                  onClick={() => {
                    const org = orgs?.[0];
                    const url = org
                      ? getOrgCourseUrl(org.slug, course.slug, org.customDomain, org.domainVerificationStatus)
                      : `/courses/${course.slug}`;
                    window.open(url, "_blank");
                  }}
                >
                  <Eye className="h-4 w-4" />
                  Preview Sales Page
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                The sales page builder opens in full-screen mode. Your changes are saved automatically.
              </p>
            </div>
          </div>
        )}

        {activeTab === "after_purchase" && (
          <AfterPurchaseTab course={course} courseId={courseId} onSave={(data: any) => updateCourse.mutate({ id: courseId, ...data })} />
        )}
        {activeTab === "drip" && (
          <DripScheduleTab courseId={courseId} curriculum={curriculum || []} onRefresh={refetch} />
        )}
      </div>

      {/* Lesson Editor Sheet */}
      <LessonEditorSheet
        lesson={editingLesson ?? null}
        open={lessonEditorOpen}
        onClose={() => { setLessonEditorOpen(false); setEditingLessonId(null); }}
        onSaved={() => { refetch(); }}
        orgId={orgId}
        courseTitle={course?.title}
      />

      {/* Add Section Dialog */}
      <Dialog open={addSectionOpen} onOpenChange={setAddSectionOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Section</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <Label>Section Title</Label>
            <Input
              placeholder="e.g. Introduction"
              value={newSectionTitle}
              onChange={(e) => setNewSectionTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createSection.mutate({ courseId, title: newSectionTitle.trim(), sortOrder: curriculum?.length ?? 0 })}
              className="mt-1.5"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddSectionOpen(false)}>Cancel</Button>
            <Button
              disabled={!newSectionTitle.trim()}
              onClick={() =>
                createSection.mutate({
                  courseId,
                  title: newSectionTitle.trim(),
                  sortOrder: curriculum?.length ?? 0,
                })
              }
            >
              Add Section
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

function CourseSettingsTab({
  course,
  onSave,
}: {
  course: any;
  onSave: (data: any) => void;
}) {
  const { data: orgs } = trpc.orgs.myOrgs.useQuery();
  const orgId = orgs?.[0]?.id ?? 0;
  const { data: instructors } = trpc.lms.instructors.list.useQuery({ orgId }, { enabled: !!orgId });
  const { plan, can, limits } = useOrgPlan(orgId);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [upgradeFeature, setUpgradeFeature] = useState("");

  const [form, setForm] = useState({
    title: course.title ?? "",
    slug: course.slug ?? "",
    description: course.description ?? "",
    shortDescription: course.shortDescription ?? "",
    isPrivate: course.isPrivate ?? false,
    isHidden: course.isHidden ?? false,
    disableTextCopy: course.disableTextCopy ?? false,
    seoTitle: course.seoTitle ?? "",
    seoDescription: course.seoDescription ?? "",
    enableChapterShare: course.enableChapterShare ?? true,
    enableCompletionShare: course.enableCompletionShare ?? true,
    socialShareText: course.socialShareText ?? "",
    // Player appearance
    playerThemeColor: course.playerThemeColor ?? "",
    playerSidebarStyle: course.playerSidebarStyle ?? "full",
    playerShowProgress: course.playerShowProgress ?? true,
    playerShowProgressPercent: course.playerShowProgressPercent ?? true,
    playerAllowNotes: course.playerAllowNotes ?? false,
    playerShowLessonIcons: course.playerShowLessonIcons ?? true,
    // Completion
    completionType: course.completionType ?? "all_lessons",
    completionPercentage: course.completionPercentage ?? 100,
    showCompleteButton: course.showCompleteButton ?? true,
    enableCertificate: course.enableCertificate ?? false,
    trackProgress: course.trackProgress ?? true,
    requireSequential: course.requireSequential ?? false,
    language: course.language ?? "en",
    // After purchase
    welcomeEmailEnabled: course.welcomeEmailEnabled ?? true,
    welcomeEmailSubject: course.welcomeEmailSubject ?? "",
    welcomeEmailBody: course.welcomeEmailBody ?? "",
    afterPurchaseRedirectUrl: course.afterPurchaseRedirectUrl ?? "",
    // Page code
    headerCode: course.headerCode ?? "",
    footerCode: course.footerCode ?? "",
    // Cover image
    thumbnailUrl: course.thumbnailUrl ?? "",
    // Instructor
    instructorId: course.instructorId ?? null,
    // Access Duration
    accessDurationType: (course.accessDurationType ?? "lifetime") as "lifetime" | "days" | "date",
    accessDurationDays: course.accessDurationDays ?? 30,
    accessExpiryDate: course.accessExpiryDate ? new Date(course.accessExpiryDate).toISOString().split("T")[0] : "",
    // Watermark override
    watermarkImageUrl: course.watermarkImageUrl ?? "",
    watermarkOpacity: course.watermarkOpacity ?? 30,
    watermarkPosition: course.watermarkPosition ?? "bottom-left",
    watermarkSize: course.watermarkSize ?? 120,
  });

  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));

  const gated = (feature: keyof typeof limits, fn: () => void) => {
    if (!can(feature)) {
      setUpgradeFeature(feature);
      setUpgradeOpen(true);
    } else {
      fn();
    }
  };

  return (
    <div className="max-w-2xl mx-auto flex flex-col gap-8">
      <UpgradePromptDialog open={upgradeOpen} onClose={() => setUpgradeOpen(false)} featureName={upgradeFeature} requiredPlan={plan} />

      {/* Basic */}
      <section className="border border-border rounded-xl p-6 flex flex-col gap-5">
        <h2 className="font-semibold text-base">Basic Settings</h2>
        {/* Course Cover Image */}
        <CourseThumbnailUpload
          orgId={orgId}
          value={form.thumbnailUrl}
          onChange={(url) => set("thumbnailUrl", url)}
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="col-span-2">
            <Label>Course Name</Label>
            <Input value={form.title} onChange={(e) => set("title", e.target.value)} className="mt-1.5" />
          </div>
          <div className="col-span-2">
            <Label>Course URL Slug</Label>
            <Input value={form.slug} onChange={(e) => set("slug", e.target.value)} className="mt-1.5" />
            {form.slug && (
              <div className="mt-2 flex items-center gap-2 p-2.5 bg-muted/50 rounded-md border border-border/60">
                <ExternalLink className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <code className="text-xs flex-1 break-all text-muted-foreground select-all">
                  {window.location.origin}/lms/courses/{form.slug}
                </code>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0 h-7 w-7 p-0"
                  title="Copy course URL"
                  onClick={() => {
                    navigator.clipboard.writeText(`${window.location.origin}/lms/courses/${form.slug}`);
                    toast.success("Course URL copied!");
                  }}
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>
          <div className="col-span-2">
            <Label>Short Description</Label>
            <Input value={form.shortDescription} onChange={(e) => set("shortDescription", e.target.value)} placeholder="Shown on course cards" className="mt-1.5" />
          </div>
          <div className="col-span-2">
            <Label>Full Description</Label>
            <Textarea value={form.description} onChange={(e) => set("description", e.target.value)} rows={4} className="mt-1.5" />
          </div>
          <div>
            <Label>Language</Label>
            <Select value={form.language} onValueChange={(v) => set("language", v)}>
              <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="en">English</SelectItem>
                <SelectItem value="es">Spanish</SelectItem>
                <SelectItem value="fr">French</SelectItem>
                <SelectItem value="de">German</SelectItem>
                <SelectItem value="pt">Portuguese</SelectItem>
                <SelectItem value="zh">Chinese</SelectItem>
                <SelectItem value="ja">Japanese</SelectItem>
                <SelectItem value="ar">Arabic</SelectItem>
              </SelectContent>
              </Select>
          </div>
          <div>
            <Label>Instructor</Label>
            <Select
              value={form.instructorId ? String(form.instructorId) : "none"}
              onValueChange={(v) => set("instructorId", v === "none" ? null : parseInt(v))}
            >
              <SelectTrigger className="mt-1.5"><SelectValue placeholder="Select instructor..." /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No instructor assigned</SelectItem>
                {(instructors ?? []).map((inst: any) => (
                  <SelectItem key={inst.id} value={String(inst.id)}>{inst.name}{inst.title ? ` — ${inst.title}` : ""}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!instructors?.length && (
              <p className="text-xs text-muted-foreground mt-1">No instructors found. Add instructors in Org Settings → Instructors.</p>
            )}
          </div>
        </div>
        <div>
          <Label>Access</Label>
          <div className="flex flex-col gap-3 mt-2">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Private course</p>
                <p className="text-xs text-muted-foreground">Only accessible via direct link or enrollment</p>
              </div>
              <Switch checked={form.isPrivate} onCheckedChange={(v) => set("isPrivate", v)} />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Hidden course</p>
                <p className="text-xs text-muted-foreground">Not shown in course catalog</p>
              </div>
              <Switch checked={form.isHidden} onCheckedChange={(v) => set("isHidden", v)} />
            </div>
          </div>
        </div>
        <div>
          <Label>Security</Label>
          <div className="flex items-center justify-between mt-2">
            <div>
              <p className="text-sm font-medium">Disable text copying</p>
              <p className="text-xs text-muted-foreground">Prevents students from selecting/copying lesson text</p>
            </div>
            <Switch checked={form.disableTextCopy} onCheckedChange={(v) => set("disableTextCopy", v)} />
          </div>
        </div>
      </section>

      {/* Player Appearance */}
      <section className="border border-border rounded-xl p-6 flex flex-col gap-5">
        <h2 className="font-semibold text-base">Player Appearance</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <Label>Theme Color</Label>
            <div className="flex items-center gap-2 mt-1.5">
              <input
                type="color"
                value={form.playerThemeColor || "#0ea5e9"}
                onChange={(e) => set("playerThemeColor", e.target.value)}
                className="h-9 w-14 rounded border border-border cursor-pointer"
              />
              <Input
                value={form.playerThemeColor}
                onChange={(e) => set("playerThemeColor", e.target.value)}
                placeholder="#0ea5e9"
                className="flex-1"
              />
            </div>
          </div>
          <div>
            <Label>Sidebar Style</Label>
            <Select value={form.playerSidebarStyle} onValueChange={(v) => set("playerSidebarStyle", v)}>
              <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="full">Full — show all sections &amp; lessons</SelectItem>
                <SelectItem value="minimal">Minimal — collapsed by default</SelectItem>
                <SelectItem value="hidden">Hidden — no sidebar</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Show progress bar</p>
              <p className="text-xs text-muted-foreground">Display overall completion % in the player</p>
            </div>
            <Switch checked={form.playerShowProgress} onCheckedChange={(v) => set("playerShowProgress", v)} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Show progress percentage</p>
              <p className="text-xs text-muted-foreground">Display the numeric completion percentage alongside the progress bar</p>
            </div>
            <Switch checked={form.playerShowProgressPercent} onCheckedChange={(v) => set("playerShowProgressPercent", v)} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Show lesson type icons</p>
              <p className="text-xs text-muted-foreground">Display icons next to lessons in the sidebar</p>
            </div>
            <Switch checked={form.playerShowLessonIcons} onCheckedChange={(v) => set("playerShowLessonIcons", v)} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Allow student notes</p>
              <p className="text-xs text-muted-foreground">Students can take private notes on each lesson</p>
            </div>
            <Switch checked={form.playerAllowNotes} onCheckedChange={(v) => set("playerAllowNotes", v)} />
          </div>
        </div>
        {/* Watermark Override */}
        <div className="border-t border-border pt-4 flex flex-col gap-3">
          <div>
            <p className="text-sm font-medium">Video Watermark Override</p>
            <p className="text-xs text-muted-foreground">Override the org-level watermark for this course. Leave blank to use org default.</p>
          </div>
          <div className="flex flex-col gap-2">
            <Label className="text-xs">Watermark Image URL</Label>
            <Input
              placeholder="https://... (PNG with transparent background recommended)"
              value={form.watermarkImageUrl}
              onChange={(e) => set("watermarkImageUrl", e.target.value)}
              className="h-8 text-sm"
            />
          </div>
          {form.watermarkImageUrl && (
            <>
              <div className="flex flex-col gap-2">
                <Label className="text-xs">Position</Label>
                <Select value={form.watermarkPosition} onValueChange={(v) => set("watermarkPosition", v)}>
                  <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bottom-left">Bottom Left</SelectItem>
                    <SelectItem value="bottom-right">Bottom Right</SelectItem>
                    <SelectItem value="top-left">Top Left</SelectItem>
                    <SelectItem value="top-right">Top Right</SelectItem>
                    <SelectItem value="center">Center</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-2">
                <Label className="text-xs">Opacity: {form.watermarkOpacity}%</Label>
                <input
                  type="range" min={5} max={100} step={5}
                  value={form.watermarkOpacity}
                  onChange={(e) => set("watermarkOpacity", Number(e.target.value))}
                  className="w-full"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label className="text-xs">Size: {form.watermarkSize}px</Label>
                <input
                  type="range" min={40} max={300} step={10}
                  value={form.watermarkSize}
                  onChange={(e) => set("watermarkSize", Number(e.target.value))}
                  className="w-full"
                />
              </div>
            </>
          )}
        </div>
      </section>

      {/* Progress & Completion */}
      <section className="border border-border rounded-xl p-6 flex flex-col gap-5">
        <h2 className="font-semibold text-base">Progress &amp; Completion</h2>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Track progress</p>
              <p className="text-xs text-muted-foreground">Record which lessons students have completed</p>
            </div>
            <Switch checked={form.trackProgress} onCheckedChange={(v) => set("trackProgress", v)} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Show Complete &amp; Continue button</p>
              <p className="text-xs text-muted-foreground">Students must click to mark lessons complete</p>
            </div>
            <Switch checked={form.showCompleteButton} onCheckedChange={(v) => set("showCompleteButton", v)} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Require sequential order</p>
              <p className="text-xs text-muted-foreground">Students must complete lessons in order</p>
            </div>
            <Switch checked={form.requireSequential} onCheckedChange={(v) => set("requireSequential", v)} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Enable certificate on completion</p>
              <p className="text-xs text-muted-foreground">Auto-generate a certificate when course is completed</p>
            </div>
            <Switch
              checked={form.enableCertificate}
              onCheckedChange={(v) => {
                if (v && !can("certificates")) {
                  setUpgradeFeature("certificates");
                  setUpgradeOpen(true);
                } else {
                  set("enableCertificate", v);
                }
              }}
            />
          </div>
        </div>
        <div>
          <Label>Completion criteria</Label>
          <Select value={form.completionType} onValueChange={(v) => set("completionType", v)}>
            <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all_lessons">Complete all lessons</SelectItem>
              <SelectItem value="percentage">Complete a percentage of lessons</SelectItem>
              <SelectItem value="quiz_pass">Pass a required quiz</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {form.completionType === "percentage" && (
          <div>
            <Label>Completion percentage: {form.completionPercentage}%</Label>
            <input
              type="range"
              min={1}
              max={100}
              value={form.completionPercentage}
              onChange={(e) => set("completionPercentage", parseInt(e.target.value))}
              className="w-full mt-2"
            />
          </div>
        )}
      </section>

      {/* Access Duration */}
      <section className="border border-border rounded-xl p-6 flex flex-col gap-5">
        <div>
          <h2 className="font-semibold text-base">Content Access Duration</h2>
          <p className="text-xs text-muted-foreground mt-1">How long students have access to this course after enrollment</p>
        </div>
        <div>
          <Label>Access type</Label>
          <Select value={form.accessDurationType} onValueChange={(v) => set("accessDurationType", v as "lifetime" | "days" | "date")}>
            <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="lifetime">Full lifetime access</SelectItem>
              <SelectItem value="days">Limited — number of days</SelectItem>
              <SelectItem value="date">Limited — fixed expiry date</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {form.accessDurationType === "days" && (
          <div>
            <Label>Number of days after enrollment</Label>
            <div className="flex items-center gap-2 mt-1.5">
              <Input
                type="number"
                min={1}
                max={3650}
                value={form.accessDurationDays}
                onChange={(e) => set("accessDurationDays", parseInt(e.target.value) || 30)}
                className="w-32"
              />
              <span className="text-sm text-muted-foreground">days</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">e.g. 30 = access expires 30 days after enrollment</p>
          </div>
        )}
        {form.accessDurationType === "date" && (
          <div>
            <Label>Access expiry date</Label>
            <Input
              type="date"
              value={form.accessExpiryDate}
              onChange={(e) => set("accessExpiryDate", e.target.value)}
              className="mt-1.5 w-48"
            />
            <p className="text-xs text-muted-foreground mt-1">All students lose access on this date regardless of when they enrolled</p>
          </div>
        )}
      </section>

      {/* After Purchase */}
      <section className="border border-border rounded-xl p-6 flex flex-col gap-5">
        <h2 className="font-semibold text-base">After Purchase</h2>
        <div>
          <Label>Redirect URL after enrollment</Label>
          <Input
            value={form.afterPurchaseRedirectUrl}
            onChange={(e) => set("afterPurchaseRedirectUrl", e.target.value)}
            placeholder="https://example.com/welcome"
            className="mt-1.5"
          />
          <p className="text-xs text-muted-foreground mt-1">Leave blank to go directly to the course player</p>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Send welcome email</p>
            <p className="text-xs text-muted-foreground">Automatically email new students on enrollment</p>
          </div>
          <Switch checked={form.welcomeEmailEnabled} onCheckedChange={(v) => set("welcomeEmailEnabled", v)} />
        </div>
        {form.welcomeEmailEnabled && (
          <>
            <div>
              <Label>Email subject</Label>
              <Input
                value={form.welcomeEmailSubject}
                onChange={(e) => set("welcomeEmailSubject", e.target.value)}
                placeholder="Welcome to {course_name}!"
                className="mt-1.5"
              />
            </div>
            <div>
              <Label>Email body</Label>
              <Textarea
                value={form.welcomeEmailBody}
                onChange={(e) => set("welcomeEmailBody", e.target.value)}
                rows={5}
                placeholder="Hi {student_name}, welcome to the course..."
                className="mt-1.5"
              />
              <p className="text-xs text-muted-foreground mt-1">Available tokens: {'{student_name}'}, {'{course_name}'}, {'{course_url}'}</p>
            </div>
          </>
        )}
      </section>

      {/* Page Code — Pro+ gated */}
      <section className="border border-border rounded-xl p-6 flex flex-col gap-5">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-base">Page Code</h2>
          {!can("customCode") && (
            <Badge variant="outline" className="text-xs border-amber-400 text-amber-600">Pro+</Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground -mt-2">Add custom HTML/JS to the course player page. We cannot provide support for custom code.</p>
        <div>
          <Label>Header code (before &lt;/head&gt;)</Label>
          <Textarea
            value={form.headerCode}
            onChange={(e) => {
              if (!can("customCode")) { setUpgradeFeature("customCode"); setUpgradeOpen(true); return; }
              set("headerCode", e.target.value);
            }}
            rows={4}
            placeholder="<!-- Google Analytics, etc. -->"
            className="mt-1.5 font-mono text-xs"
            disabled={!can("customCode")}
          />
        </div>
        <div>
          <Label>Footer code (before &lt;/body&gt;)</Label>
          <Textarea
            value={form.footerCode}
            onChange={(e) => {
              if (!can("customCode")) { setUpgradeFeature("customCode"); setUpgradeOpen(true); return; }
              set("footerCode", e.target.value);
            }}
            rows={4}
            placeholder="<!-- Custom scripts -->"
            className="mt-1.5 font-mono text-xs"
            disabled={!can("customCode")}
          />
        </div>
      </section>

      {/* Social sharing */}
      <section className="border border-border rounded-xl p-6 flex flex-col gap-5">
        <h2 className="font-semibold text-base">Social Sharing</h2>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Share at chapter completion</p>
            <Switch checked={form.enableChapterShare} onCheckedChange={(v) => set("enableChapterShare", v)} />
          </div>
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Share at course completion</p>
            <Switch checked={form.enableCompletionShare} onCheckedChange={(v) => set("enableCompletionShare", v)} />
          </div>
        </div>
        <div>
          <Label>Social sharing text</Label>
          <Input
            value={form.socialShareText}
            onChange={(e) => set("socialShareText", e.target.value)}
            placeholder="Check out this course!"
            className="mt-1.5"
          />
          <p className="text-xs text-muted-foreground mt-1">Used as default content for X/Twitter</p>
        </div>
      </section>

      {/* SEO */}
      <section className="border border-border rounded-xl p-6 flex flex-col gap-4">
        <h2 className="font-semibold text-base">SEO</h2>
        <div>
          <Label>SEO Title</Label>
          <Input value={form.seoTitle} onChange={(e) => set("seoTitle", e.target.value)} className="mt-1.5" />
        </div>
        <div>
          <Label>SEO Description</Label>
          <Input value={form.seoDescription} onChange={(e) => set("seoDescription", e.target.value)} className="mt-1.5" />
        </div>
      </section>

      <Button
        onClick={() => {
          const saveData: any = { ...form };
          // Convert accessExpiryDate string to Date object if set
          if (form.accessDurationType === "date" && form.accessExpiryDate) {
            saveData.accessExpiryDate = new Date(form.accessExpiryDate);
          } else {
            saveData.accessExpiryDate = null;
          }
          if (form.accessDurationType !== "days") {
            saveData.accessDurationDays = null;
          }
          onSave(saveData);
        }}
        className="self-start"
      >
        Save Settings
      </Button>
    </div>
  );
}

// ─── Pricing Tab ──────────────────────────────────────────────────────────────

function CoursePricingTab({ courseId }: { courseId: number }) {
  const utils = trpc.useUtils();
  const { data: orgs } = trpc.orgs.myOrgs.useQuery();
  const orgId = orgs?.[0]?.id;
  const { data: pricing } = trpc.lms.pricing.list.useQuery({ courseId });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    pricingType: "one_time" as "free" | "one_time" | "subscription" | "payment_plan",
    price: 0,
    billingInterval: "month" as "month" | "year",
    accessDays: undefined as number | undefined,
  });

  const createPricing = trpc.lms.pricing.create.useMutation({
    onSuccess: () => {
      utils.lms.pricing.list.invalidate({ courseId });
      setOpen(false);
      toast.success("Pricing option added");
    },
    onError: (e) => toast.error(e.message),
  });
  const deletePricing = trpc.lms.pricing.delete.useMutation({
    onSuccess: () => utils.lms.pricing.list.invalidate({ courseId }),
  });

  return (
    <div className="max-w-2xl mx-auto flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Pricing Options</h2>
        <Button size="sm" onClick={() => setOpen(true)} className="gap-1.5">
          <Plus className="h-4 w-4" /> Add Pricing
        </Button>
      </div>

      {pricing?.length === 0 && (
        <div className="border-2 border-dashed border-border rounded-xl p-10 text-center text-muted-foreground">
          <DollarSign className="h-8 w-8 mx-auto mb-2 opacity-40" />
          <p className="text-sm">No pricing options yet. Add one to start selling this course.</p>
        </div>
      )}

      {pricing?.map((p) => (
        <div key={p.id} className="border border-border rounded-xl p-4 flex items-center justify-between">
          <div>
            <p className="font-medium text-sm">{p.name}</p>
            <p className="text-xs text-muted-foreground capitalize">
              {p.pricingType === "free" ? "Free" : `$${p.price} ${p.pricingType === "subscription" ? `/ ${(p as any).billingInterval ?? "month"}` : ""}`}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-destructive hover:text-destructive"
            onClick={() => deletePricing.mutate({ id: p.id })}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Pricing Option</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <div>
              <Label>Name</Label>
              <Input value={form.name} onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Monthly Access" className="mt-1.5" />
            </div>
            <div>
              <Label>Type</Label>
              <Select value={form.pricingType} onValueChange={(v: any) => setForm(f => ({ ...f, pricingType: v }))}>
                <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="free">Free</SelectItem>
                  <SelectItem value="one_time">One-time payment</SelectItem>
                  <SelectItem value="subscription">Subscription</SelectItem>
                  <SelectItem value="payment_plan">Payment plan</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.pricingType !== "free" && (
              <div>
                <Label>Price (USD)</Label>
                <Input type="number" value={form.price} onChange={(e) => setForm(f => ({ ...f, price: parseFloat(e.target.value) || 0 }))} className="mt-1.5" />
              </div>
            )}
            {form.pricingType === "subscription" && (
              <div>
                <Label>Billing Interval</Label>
                <Select value={form.billingInterval} onValueChange={(v: any) => setForm(f => ({ ...f, billingInterval: v }))}>
                  <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="month">Monthly</SelectItem>
                    <SelectItem value="year">Yearly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              disabled={!form.name || !orgId}
              onClick={() => createPricing.mutate({ courseId, orgId: orgId!, ...form })}
            >
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Course Thumbnail Upload ──────────────────────────────────────────────────
function CourseThumbnailUpload({
  orgId,
  value,
  onChange,
}: {
  orgId: number;
  value: string;
  onChange: (url: string) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const getUploadUrl = trpc.lms.media.getUploadUrl.useMutation();

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const { fileUrl } = await getUploadUrl.mutateAsync({
        orgId,
        fileName: file.name,
        contentType: file.type || "image/jpeg",
      });
      await fetch(fileUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type || "image/jpeg" },
      });
      // Strip query params to get clean URL
      const cleanUrl = fileUrl.split("?")[0];
      onChange(cleanUrl);
      toast.success("Cover image uploaded");
    } catch (err: any) {
      toast.error("Upload failed: " + (err.message ?? "Unknown error"));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Label>Course Cover Image</Label>
      <div className="flex items-start gap-4">
        {/* Preview */}
        <div className="relative w-36 h-24 rounded-lg border border-border bg-muted overflow-hidden flex-shrink-0">
          {value ? (
            <img src={value} alt="Cover" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center gap-1 text-muted-foreground">
              <svg className="h-8 w-8 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <span className="text-xs">No image</span>
            </div>
          )}
        </div>
        {/* Controls */}
        <div className="flex flex-col gap-2 flex-1">
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={uploading}
              asChild
            >
              <label className="cursor-pointer">
                {uploading ? "Uploading..." : "Upload Image"}
                <input
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  onChange={handleFile}
                />
              </label>
            </Button>
            {value && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onChange("")}
              >
                Remove
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Recommended: 1280×720px (16:9 ratio), JPG or PNG format
          </p>
          {value && (
            <div className="flex gap-2 items-center">
              <Label className="text-xs">URL</Label>
              <Input
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder="https://..."
                className="h-7 text-xs"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


// ─── After Purchase Tab ─────────────────────────────────────────────────────
function AfterPurchaseTab({ course, courseId, onSave }: { course: any; courseId: number; onSave: (data: any) => void }) {
  const [, setLocation] = useLocation();
  const [welcomeEmailEnabled, setWelcomeEmailEnabled] = useState(course?.welcomeEmailEnabled ?? true);
  const [welcomeEmailSubject, setWelcomeEmailSubject] = useState(course?.welcomeEmailSubject ?? "");
  const [welcomeEmailBody, setWelcomeEmailBody] = useState(course?.welcomeEmailBody ?? "");
  const [afterPurchaseRedirectUrl, setAfterPurchaseRedirectUrl] = useState(course?.afterPurchaseRedirectUrl ?? "");
  const [thankYouPageEnabled, setThankYouPageEnabled] = useState(course?.thankYouPageEnabled ?? false);
  const [dirty, setDirty] = useState(false);
  const { data: orgs } = trpc.orgs.myOrgs.useQuery();

  const handleSave = () => {
    onSave({
      welcomeEmailEnabled,
      welcomeEmailSubject: welcomeEmailSubject || null,
      welcomeEmailBody: welcomeEmailBody || null,
      afterPurchaseRedirectUrl: afterPurchaseRedirectUrl || null,
      thankYouPageEnabled,
    });
    setDirty(false);
    toast.success("After-purchase settings saved");
  };

  const thankYouPageUrl = (() => {
    const org = orgs?.[0];
    if (org) {
      return getOrgThankYouUrl(org.slug, courseId, org.customDomain, org.domainVerificationStatus);
    }
    return `/courses/${courseId}/thank-you`;
  })();

  return (
    <div className="max-w-2xl mx-auto space-y-8 py-6">
      <div>
        <h2 className="text-lg font-semibold mb-1">After Purchase Settings</h2>
        <p className="text-sm text-muted-foreground">Configure what happens after a student purchases this course.</p>
      </div>

      {/* Custom Thank You Page */}
      <div className="space-y-4 border border-border rounded-xl p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-muted-foreground" />
            <Label className="font-medium">Custom Thank You Page</Label>
          </div>
          <Switch
            checked={thankYouPageEnabled}
            onCheckedChange={(v) => { setThankYouPageEnabled(v); setDirty(true); }}
          />
        </div>
        <p className="text-sm text-muted-foreground">
          Show a custom thank-you page after purchase instead of the default confirmation. Build it with the page builder using your brand colors and messaging.
        </p>
        {thankYouPageEnabled && (
          <div className="space-y-3 pt-2">
            <Button
              variant="outline"
              className="gap-2 border-teal-300 text-teal-700 hover:bg-teal-50"
              onClick={() => setLocation(`/lms/courses/${courseId}/thank-you-builder`)}
            >
              <Edit className="h-4 w-4" />
              Open Thank You Page Builder
            </Button>
            <p className="text-xs text-muted-foreground">
              Public URL: <span className="font-mono text-teal-600">{thankYouPageUrl}</span>
            </p>
          </div>
        )}
      </div>

      {/* Redirect URL */}
      <div className="space-y-3 border border-border rounded-xl p-5">
        <div className="flex items-center gap-2">
          <ExternalLink className="h-4 w-4 text-muted-foreground" />
          <Label className="font-medium">Post-Purchase Redirect URL</Label>
        </div>
        <p className="text-sm text-muted-foreground">
          After successful purchase, redirect the student to this URL instead of the default thank-you page.
          Leave empty to use the custom thank-you page (if enabled) or the default course access page.
        </p>
        <Input
          placeholder="https://example.com/thank-you"
          value={afterPurchaseRedirectUrl}
          onChange={(e) => { setAfterPurchaseRedirectUrl(e.target.value); setDirty(true); }}
        />
        {afterPurchaseRedirectUrl && thankYouPageEnabled && (
          <p className="text-xs text-amber-600">
            Note: The redirect URL takes priority over the custom thank-you page. Clear this field to use your custom page.
          </p>
        )}
      </div>

      {/* Welcome Email */}
      <div className="space-y-4 border border-border rounded-xl p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-muted-foreground" />
            <Label className="font-medium">Welcome Email</Label>
          </div>
          <Switch
            checked={welcomeEmailEnabled}
            onCheckedChange={(v) => { setWelcomeEmailEnabled(v); setDirty(true); }}
          />
        </div>
        <p className="text-sm text-muted-foreground">
          Send an automated welcome email when a student enrolls in this course.
        </p>

        {welcomeEmailEnabled && (
          <div className="space-y-3 pt-2">
            <div>
              <Label className="text-sm">Subject Line</Label>
              <Input
                placeholder="Welcome to {{course_title}}!"
                value={welcomeEmailSubject}
                onChange={(e) => { setWelcomeEmailSubject(e.target.value); setDirty(true); }}
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Available variables: {"{{course_title}}"}, {"{{student_name}}"}, {"{{instructor_name}}"}
              </p>
            </div>
            <div>
              <Label className="text-sm">Email Body</Label>
              <Textarea
                placeholder="Hi {{student_name}},&#10;&#10;Welcome to {{course_title}}! We're excited to have you on board.&#10;&#10;Here's how to get started..."
                value={welcomeEmailBody}
                onChange={(e) => { setWelcomeEmailBody(e.target.value); setDirty(true); }}
                className="mt-1 min-h-[150px]"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Available variables: {"{{course_title}}"}, {"{{student_name}}"}, {"{{instructor_name}}"}, {"{{course_url}}"}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Save */}
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={!dirty}>
          Save Settings
        </Button>
      </div>
    </div>
  );
}

// ─── Drip Schedule Tab ──────────────────────────────────────────────────────
function DripScheduleTab({
  courseId,
  curriculum,
  onRefresh,
}: {
  courseId: number;
  curriculum: Array<{
    id: number;
    title: string;
    lessons: Array<{
      id: number;
      title: string;
      lessonType: string;
      dripType?: string;
      dripDays?: number | null;
      dripDate?: string | Date | null;
      sortOrder: number;
    }>;
  }>;
  onRefresh: () => void;
}) {
  const updateLesson = trpc.lms.curriculum.updateLesson.useMutation({
    onSuccess: () => {
      onRefresh();
      toast.success("Drip schedule updated");
    },
    onError: (e) => toast.error(e.message),
  });

  const allLessons = curriculum.flatMap((section) =>
    section.lessons.map((l) => ({ ...l, sectionTitle: section.title }))
  );

  const handleDripChange = (lessonId: number, dripType: string, dripDays?: number | null, dripDate?: string | null) => {
    updateLesson.mutate({
      id: lessonId,
      dripType: dripType as any,
      dripDays: dripType === "days_after_enrollment" ? (dripDays ?? 0) : null,
      dripDate: dripType === "specific_date" ? dripDate : null,
    });
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6 py-6">
      <div>
        <h2 className="text-lg font-semibold mb-1">Drip Schedule</h2>
        <p className="text-sm text-muted-foreground">
          Control when lessons become available to students. Use drip scheduling to release content gradually
          over time after enrollment, or on specific dates.
        </p>
      </div>

      <div className="border border-border rounded-xl overflow-hidden">
        <div className="grid grid-cols-[1fr_180px_140px] gap-2 px-4 py-2.5 bg-muted/50 text-xs font-medium text-muted-foreground border-b border-border">
          <span>Lesson</span>
          <span>Release Type</span>
          <span>Schedule</span>
        </div>

        {allLessons.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No lessons yet. Add lessons in the Curriculum tab first.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {allLessons.map((lesson) => (
              <DripLessonRow
                key={lesson.id}
                lesson={lesson}
                onDripChange={handleDripChange}
                isUpdating={updateLesson.isPending}
              />
            ))}
          </div>
        )}
      </div>

      <div className="bg-muted/30 border border-border rounded-xl p-4 space-y-2">
        <h3 className="text-sm font-medium flex items-center gap-2">
          <Clock className="h-4 w-4" /> How Drip Scheduling Works
        </h3>
        <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
          <li><strong>Immediately</strong> — Lesson is available as soon as the student enrolls.</li>
          <li><strong>Days after enrollment</strong> — Lesson unlocks X days after the student's enrollment date.</li>
          <li><strong>Specific date</strong> — Lesson unlocks on a specific calendar date for all students.</li>
        </ul>
      </div>
    </div>
  );
}

function DripLessonRow({
  lesson,
  onDripChange,
  isUpdating,
}: {
  lesson: { id: number; title: string; lessonType: string; sectionTitle: string; dripType?: string; dripDays?: number | null; dripDate?: string | Date | null };
  onDripChange: (lessonId: number, dripType: string, dripDays?: number | null, dripDate?: string | null) => void;
  isUpdating: boolean;
}) {
  const [dripType, setDripType] = useState(lesson.dripType ?? "immediate");
  const [dripDays, setDripDays] = useState(lesson.dripDays ?? 0);
  const [dripDate, setDripDate] = useState(
    lesson.dripDate ? (typeof lesson.dripDate === "string" ? lesson.dripDate.split("T")[0] : new Date(lesson.dripDate).toISOString().split("T")[0]) : ""
  );

  const handleTypeChange = (newType: string) => {
    setDripType(newType);
    onDripChange(lesson.id, newType, dripDays, dripDate || null);
  };

  const handleDaysBlur = () => {
    if (dripType === "days_after_enrollment") {
      onDripChange(lesson.id, dripType, dripDays, null);
    }
  };

  const handleDateChange = (val: string) => {
    setDripDate(val);
    if (dripType === "specific_date" && val) {
      onDripChange(lesson.id, dripType, null, val);
    }
  };

  return (
    <div className="grid grid-cols-[1fr_180px_140px] gap-2 px-4 py-3 items-center">
      <div className="flex items-center gap-2 min-w-0">
        {dripType === "immediate" ? (
          <Unlock className="h-3.5 w-3.5 text-green-500 shrink-0" />
        ) : (
          <Lock className="h-3.5 w-3.5 text-amber-500 shrink-0" />
        )}
        <div className="min-w-0">
          <p className="text-sm truncate">{lesson.title}</p>
          <p className="text-xs text-muted-foreground truncate">{lesson.sectionTitle}</p>
        </div>
      </div>

      <Select value={dripType} onValueChange={handleTypeChange}>
        <SelectTrigger className="h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="immediate">Immediately</SelectItem>
          <SelectItem value="days_after_enrollment">Days after enrollment</SelectItem>
          <SelectItem value="specific_date">Specific date</SelectItem>
        </SelectContent>
      </Select>

      <div>
        {dripType === "days_after_enrollment" && (
          <div className="flex items-center gap-1">
            <Input
              type="number"
              min={0}
              value={dripDays}
              onChange={(e) => setDripDays(parseInt(e.target.value) || 0)}
              onBlur={handleDaysBlur}
              className="h-8 text-xs w-16"
            />
            <span className="text-xs text-muted-foreground">days</span>
          </div>
        )}
        {dripType === "specific_date" && (
          <Input
            type="date"
            value={dripDate}
            onChange={(e) => handleDateChange(e.target.value)}
            className="h-8 text-xs"
          />
        )}
        {dripType === "immediate" && (
          <span className="text-xs text-green-600">Available now</span>
        )}
      </div>
    </div>
  );
}
