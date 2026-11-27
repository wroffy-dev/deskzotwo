import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { learningPage } from "@/actions/learning";
import { Card } from "@/components/ui/card";
import { CourseCard, CourseForm, MyCourseCard } from "@/components/hr/learning";

export const metadata = { title: "Learning" };

/** People › Learning (owner, 31 Oct 2026 — src/actions/learning.ts): my courses; HR's courses, a manager's team's. */
export default async function LearningPage() {
  if (!(await isModuleEnabled("hr"))) return <ModuleDisabledNotice moduleKey="hr" />;
  const { hr, manages, mine, courses, departments, people } = await learningPage();
  return (
    <div className="animate-fade-rise space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-text">Learning</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">Courses you&apos;ve been given — open the material, then mark each one done.</p>
      </div>
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-text">My courses</h2>
        {mine.length === 0 ? (
          <Card className="p-4 text-sm text-muted">Nothing to take right now.</Card>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {mine.map((c) => (
              <MyCourseCard key={c.assignmentId} course={c} />
            ))}
          </div>
        )}
      </section>
      {manages && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-text">{hr ? "Courses" : "My team's courses"}</h2>
          {hr && <CourseForm />}
          {courses.length === 0 && !hr && <Card className="p-4 text-sm text-muted">Your team hasn&apos;t been given a course yet.</Card>}
          {courses.map((c) => (
            <CourseCard key={c.id} course={c} hr={hr} people={people} departments={departments} />
          ))}
        </section>
      )}
    </div>
  );
}
