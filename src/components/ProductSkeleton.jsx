export default function ProductSkeleton() {
  return (
    <div className="group relative bg-surface-container/30 rounded-2xl overflow-hidden border border-white/5 backdrop-blur-xl flex flex-col h-full" dir="rtl">
      
      {/* Image Skeleton */}
      <div className="relative h-[260px] w-full bg-white/5 p-6 flex items-center justify-center overflow-hidden">
        <div className="skeleton w-32 h-32 rounded-2xl opacity-40"></div>
      </div>

      {/* Content Skeleton */}
      <div className="p-6 flex-1 flex flex-col relative z-10">
        <div className="space-y-4 mb-auto">
          {/* Category Tag Skeleton */}
          <div className="skeleton h-4 w-20 rounded-md opacity-30"></div>
          
          {/* Title Skeletons */}
          <div className="skeleton h-6 w-full rounded-md"></div>
          <div className="skeleton h-6 w-2/3 rounded-md"></div>
        </div>

        <div className="flex flex-col mt-6 pt-6 border-t border-white/5 space-y-6">
          {/* Price Section Skeleton */}
          <div className="flex items-center justify-between" dir="ltr">
            <div className="space-y-2">
              <div className="skeleton h-3 w-16 rounded-md opacity-30"></div>
              <div className="skeleton h-7 w-28 rounded-md"></div>
            </div>
            <div className="skeleton h-8 w-20 rounded-lg opacity-40"></div>
          </div>
          
          {/* Button Skeleton */}
          <div className="skeleton h-12 w-full rounded-xl"></div>
        </div>
      </div>
    </div>
  );
}
